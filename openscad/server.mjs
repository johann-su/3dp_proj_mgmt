// Thin HTTP wrapper around the headless OpenSCAD CLI, mirroring the slicer service (slicer/server.mjs). Zero npm dependencies: the container is just OpenSCAD's official development build (+ MCAD/BOSL2 libraries) + nodejs. Renders a parametric .scad source with a set of customizer values into a .3mf mesh, using the Manifold renderer.
//
//   GET  /healthz   liveness probe
//   POST /render    body = JSON { source, parameters: {name: string}, format? }
//     format "3mf" (default, for storage) or "stl" (binary, for the browser
//     preview — smaller and directly parseable by three.js)
//     -> 200 raw model bytes (model/3mf or application/octet-stream)
//     -> 400 { ok: false, error }   malformed request
//     -> 422 { ok: false, error }   OpenSCAD rejected the source / timed out
//     -> 413/500 on oversize body / unexpected errors
//
// Parameters are applied via OpenSCAD's parameter-set JSON (-p/-P), never via -D — values cannot become extra CLI flags. The app validates the source before calling (customizer schema, include allowlist in src/lib/scad-params.ts); this service additionally runs inside a container with nothing sensitive, renders in an empty temp dir, and enforces a hard timeout because OpenSCAD happily recurses or $fn-explodes forever.
//
// Rendering is CPU-bound, so requests are processed one at a time. A request whose caller disconnects is dropped from the queue, or its OpenSCAD process killed if already running, so superseded previews don't delay the current one.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSerialQueue, scrubErrorOutput, toParameterSetJson } from "./lib.mjs";

const PORT = Number(process.env.PORT ?? 8000);
const OPENSCAD_BIN = process.env.OPENSCAD_BIN ?? "openscad";
const TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS ?? 120_000);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 8 * 1024 * 1024);

// Output formats the service will produce. Keys are the request values, the entries name the output file and OpenSCAD's --export-format id (binstl = binary STL, a fraction of the ascii size).
const FORMATS = {
  "3mf": {
    file: "output.3mf",
    exportFormat: "3mf",
    contentType: "model/3mf",
    // Keep the 3MF a plain single-object mesh, as OpenSCAD 2021.01 wrote it: newer builds add metadata plus a basematerials colour on every triangle (default "#F9D72C00", i.e. alpha 0), which slicers can treat as a filament assignment.
    options: ["-O", "export-3mf/color-mode=none", "-O", "export-3mf/add-meta-data=false"],
  },
  stl: {
    file: "output.stl",
    exportFormat: "binstl",
    contentType: "application/octet-stream",
    options: [],
  },
};

function runOpenscad(dir, hasParameters, format, signal) {
  return new Promise((resolve) => {
    const child = spawn(
      OPENSCAD_BIN,
      [
        // Manifold is the default in current builds; naming it keeps a future default change (or an OPENSCAD_BIN without it) from silently falling back to CGAL, which is 100x+ slower.
        "--backend=Manifold",
        "-o",
        join(dir, format.file),
        "--export-format",
        format.exportFormat,
        ...format.options,
        ...(hasParameters ? ["-p", join(dir, "params.json"), "-P", "app"] : []),
        join(dir, "input.scad"),
      ],
      { stdio: ["ignore", "pipe", "pipe"], cwd: dir },
    );
    let output = "";
    const collect = (chunk) => {
      if (output.length < 64 * 1024) output += chunk;
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, output, timedOut: true });
    }, TIMEOUT_MS);
    // The caller hung up (a superseded preview, or the app's own timeout): stop burning CPU on a result nobody will read.
    const onAbort = () => {
      child.kill("SIGKILL");
      resolve({ code: null, output, timedOut: false, aborted: true });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const settle = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };

    child.on("error", (err) => {
      settle();
      resolve({ code: null, output: String(err), timedOut: false });
    });
    child.on("exit", (code) => {
      settle();
      resolve({ code, output, timedOut: false });
    });
  });
}

async function render(source, paramsJson, format, signal) {
  const dir = await mkdtemp(join(tmpdir(), "scad-"));
  try {
    await writeFile(join(dir, "input.scad"), source);
    if (paramsJson !== null) {
      await writeFile(join(dir, "params.json"), paramsJson);
    }
    const result = await runOpenscad(dir, paramsJson !== null, format, signal);
    if (result.aborted) {
      console.log("render cancelled: client went away");
      return null;
    }
    if (result.timedOut) {
      return {
        status: 422,
        body: { ok: false, error: `rendering timed out after ${TIMEOUT_MS / 1000}s` },
      };
    }
    if (result.code !== 0) {
      return { status: 422, body: { ok: false, error: scrubErrorOutput(result.output) } };
    }
    let data;
    try {
      data = await readFile(join(dir, format.file));
    } catch {
      // Exit 0 without output happens for e.g. an empty top-level object.
      return { status: 422, body: { ok: false, error: scrubErrorOutput(result.output) } };
    }
    console.log(
      `rendered ${source.length}B source -> ${data.length}B ${format.exportFormat}`,
    );
    return { status: 200, data, contentType: format.contentType };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- HTTP server (same skeleton as slicer/server.mjs) -----------------------

const enqueue = createSerialQueue();

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/healthz") {
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && req.url === "/render") {
      // Aborted when the caller disconnects before we've answered: a queued render is then skipped and a running one killed.
      const hangup = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) hangup.abort();
      });
      const raw = await readBody(req);
      let source;
      let paramsJson;
      let format;
      try {
        const parsed = JSON.parse(raw.toString("utf8"));
        source = parsed.source;
        if (typeof source !== "string" || source.length === 0) {
          throw new Error("source must be a non-empty string");
        }
        format = FORMATS[parsed.format ?? "3mf"];
        if (!format) throw new Error("format must be 3mf or stl");
        const parameters = parsed.parameters ?? {};
        // Validate before queueing so bad input is a 400, not a queued 500.
        paramsJson =
          Object.keys(parameters).length > 0 ? toParameterSetJson(parameters) : null;
      } catch (err) {
        return send(res, 400, { ok: false, error: err?.message ?? "invalid request" });
      }
      const result = await enqueue(
        () => render(source, paramsJson, format, hangup.signal),
        hangup.signal,
      );
      // Skipped or killed because the caller is gone — there is no one to answer.
      if (result === null) return;
      if (result.status === 200) {
        res.writeHead(200, {
          "content-type": result.contentType,
          "content-length": result.data.length,
        });
        return res.end(result.data);
      }
      return send(res, result.status, result.body);
    }
    send(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    send(res, err?.status ?? 500, { ok: false, error: err?.message ?? "error" });
  }
});

server.listen(PORT, () => {
  console.log(`openscad service listening on :${PORT}`);
});
