// Thin HTTP wrapper around the PrusaSlicer CLI. Zero npm dependencies so the
// container is just debian + prusa-slicer + nodejs + unzip. The pure parsing
// and config-translation helpers live in lib.mjs (unit-tested via `npm test`
// in the repo root).
//
//   GET  /healthz    liveness probe
//   POST /estimate   body = raw .3mf bytes
//     -> 200 { ok: true, printTimeSeconds, filamentGrams, filamentMm, profile }
//     -> 422 { ok: false, error }   file could not be sliced (unslicable)
//     -> 413/500 on oversize body / unexpected errors
//
// Settings embedded in the .3mf are honored where possible: Bambu Studio /
// OrcaSlicer projects carry Metadata/project_settings.config (JSON, Bambu key
// names) and PrusaSlicer projects carry Metadata/Slic3r_PE.config (ini). Known
// keys are translated/whitelisted into a derived config that overlays the
// generic baseline (config.ini); `profile` in the response reports "file" or
// "generic". Only whitelisted keys are copied, so a crafted archive cannot
// smuggle in dangerous options like post_process.
//
// Slicing is CPU-bound, so requests are processed one at a time.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fromBambuJson,
  fromPrusaIni,
  parseGcodeStats,
  usedExtruder,
} from "./lib.mjs";

const PORT = Number(process.env.PORT ?? 8000);
const PRUSA_BIN = process.env.PRUSA_SLICER_BIN ?? "prusa-slicer";
const CONFIG =
  process.env.SLICER_CONFIG ??
  join(dirname(fileURLToPath(import.meta.url)), "config.ini");
const TIMEOUT_MS = Number(process.env.SLICE_TIMEOUT_MS ?? 300_000);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 256 * 1024 * 1024);
// The stats comments sit in the gcode footer; no need to read the whole file.
const GCODE_TAIL_BYTES = 128 * 1024;

// --- embedded settings -> derived PrusaSlicer config -----------------------

function unzipEntry(archivePath, entryName) {
  return new Promise((resolve) => {
    const child = spawn("unzip", ["-p", archivePath, entryName], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks = [];
    let size = 0;
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size <= 8 * 1024 * 1024) chunks.push(chunk);
    });
    child.on("error", () => resolve(null));
    child.on("exit", (code) =>
      resolve(code === 0 && size <= 8 * 1024 * 1024 ? Buffer.concat(chunks) : null),
    );
  });
}

// Builds a config overriding the generic baseline with whatever the archive
// itself says. Returns null when the file carries no readable settings.
async function deriveConfig(inputPath, dir) {
  let derived = null;
  const projectSettings = await unzipEntry(
    inputPath,
    "Metadata/project_settings.config",
  );
  if (projectSettings) {
    try {
      const settings = JSON.parse(projectSettings.toString("utf8"));
      const modelSettings = await unzipEntry(
        inputPath,
        "Metadata/model_settings.config",
      );
      derived = fromBambuJson(
        settings,
        usedExtruder(modelSettings?.toString("utf8") ?? ""),
      );
    } catch {
      // not JSON — fall through to the PrusaSlicer ini
    }
  }
  if (!derived) {
    const ini = await unzipEntry(inputPath, "Metadata/Slic3r_PE.config");
    if (ini) derived = fromPrusaIni(ini.toString("utf8"));
  }
  if (!derived || Object.keys(derived).length === 0) return null;

  const path = join(dir, "derived.ini");
  await writeFile(
    path,
    Object.entries(derived)
      .map(([key, value]) => `${key} = ${value}`)
      .join("\n") + "\n",
  );
  return path;
}

// --- slicing ---------------------------------------------------------------

function runSlicer(inputPath, outputPath, derivedConfigPath) {
  return new Promise((resolve) => {
    const child = spawn(
      PRUSA_BIN,
      [
        "--export-gcode",
        "--load",
        CONFIG,
        // File-derived settings override the generic baseline.
        ...(derivedConfigPath ? ["--load", derivedConfigPath] : []),
        // PrusaSlicer applies a project 3mf's own embedded config on load;
        // make sure it can never run post-processing scripts.
        "--post-process",
        "",
        "--ensure-on-bed",
        "--output",
        outputPath,
        inputPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
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

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, output: String(err), timedOut: false });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut: false });
    });
  });
}

// Last meaningful line of the slicer output, for failure messages. Temp
// paths mean nothing to the caller, so strip them.
function errorLine(output) {
  const lines = output
    .split("\n")
    .map((l) => l.trim().replace(/\/tmp\/slice-[^\s:]*\/input\.3mf:?\s*/g, ""))
    .filter((l) => l && !l.startsWith("=>"));
  return lines.at(-1) ?? "slicing produced no output";
}

async function readTail(path) {
  const { size } = await stat(path);
  const handle = await open(path, "r");
  try {
    const start = Math.max(0, size - GCODE_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function estimate(body) {
  const dir = await mkdtemp(join(tmpdir(), "slice-"));
  const inputPath = join(dir, "input.3mf");
  const outputPath = join(dir, "output.gcode");
  try {
    await writeFile(inputPath, body);
    const derivedConfigPath = await deriveConfig(inputPath, dir);
    const profile = derivedConfigPath ? "file" : "generic";
    const result = await runSlicer(inputPath, outputPath, derivedConfigPath);
    if (result.timedOut) {
      return { status: 422, body: { ok: false, error: "slicing timed out" } };
    }
    if (result.code !== 0) {
      return { status: 422, body: { ok: false, error: errorLine(result.output) } };
    }
    // PrusaSlicer exits 0 without writing gcode for some rejections (e.g.
    // "All objects are outside of the print volume."); surface its message
    // instead of an ENOENT on the missing output file.
    let gcodeTail;
    try {
      gcodeTail = await readTail(outputPath);
    } catch {
      return { status: 422, body: { ok: false, error: errorLine(result.output) } };
    }
    const stats = parseGcodeStats(gcodeTail);
    if (stats.printTimeSeconds == null) {
      return {
        status: 422,
        body: { ok: false, error: "no print time in slicer output" },
      };
    }
    console.log(
      `sliced ${body.length}B profile=${profile} time=${stats.printTimeSeconds}s filament=${stats.filamentGrams}g`,
    );
    return { status: 200, body: { ok: true, profile, ...stats } };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- HTTP server -----------------------------------------------------------

let queue = Promise.resolve();
function enqueue(job) {
  const run = queue.then(job, job);
  queue = run.then(
    () => {},
    () => {},
  );
  return run;
}

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
    if (req.method === "POST" && req.url === "/estimate") {
      const body = await readBody(req);
      if (body.length === 0) {
        return send(res, 400, { ok: false, error: "empty body" });
      }
      const result = await enqueue(() => estimate(body));
      return send(res, result.status, result.body);
    }
    send(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    send(res, err?.status ?? 500, { ok: false, error: err?.message ?? "error" });
  }
});

server.listen(PORT, () => {
  console.log(`slicer service listening on :${PORT}`);
});
