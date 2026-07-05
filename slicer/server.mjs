// Thin HTTP wrapper around the PrusaSlicer CLI. Zero npm dependencies so the
// container is just debian + prusa-slicer + nodejs.
//
//   GET  /healthz    liveness probe
//   POST /estimate   body = raw .3mf bytes
//     -> 200 { ok: true, printTimeSeconds, filamentGrams, filamentMm }
//     -> 422 { ok: false, error }   file could not be sliced (unslicable)
//     -> 413/500 on oversize body / unexpected errors
//
// Slicing is CPU-bound, so requests are processed one at a time.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 8000);
const PRUSA_BIN = process.env.PRUSA_SLICER_BIN ?? "prusa-slicer";
const CONFIG =
  process.env.SLICER_CONFIG ??
  join(dirname(fileURLToPath(import.meta.url)), "config.ini");
const TIMEOUT_MS = Number(process.env.SLICE_TIMEOUT_MS ?? 300_000);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 256 * 1024 * 1024);
// The stats comments sit in the gcode footer; no need to read the whole file.
const GCODE_TAIL_BYTES = 128 * 1024;

// --- gcode stats parsing ---------------------------------------------------

const UNIT_SECONDS = { d: 86400, h: 3600, m: 60, s: 1 };

// "2d 1h 5m 30s" -> seconds
function parseDuration(text) {
  let seconds = null;
  for (const m of text.matchAll(/(\d+)\s*([dhms])/g)) {
    seconds = (seconds ?? 0) + Number(m[1]) * UNIT_SECONDS[m[2]];
  }
  return seconds;
}

// Multi-extruder values are comma-separated lists -> sum them.
function sumList(raw) {
  let total = null;
  for (const part of raw.split(",")) {
    const value = Number.parseFloat(part);
    if (Number.isFinite(value)) total = (total ?? 0) + value;
  }
  return total;
}

function parseGcodeStats(tail) {
  // First match is normal mode; a second line may exist for stealth mode.
  const time = tail.match(/^; estimated printing time.*?=\s*(.+)$/m);
  const grams =
    tail.match(/^; total filament used \[g\]\s*=\s*(.+)$/m) ??
    tail.match(/^; filament used \[g\]\s*=\s*(.+)$/m);
  const mm = tail.match(/^; filament used \[mm\]\s*=\s*(.+)$/m);
  return {
    printTimeSeconds: time ? parseDuration(time[1]) : null,
    filamentGrams: grams ? sumList(grams[1]) : null,
    filamentMm: mm ? sumList(mm[1]) : null,
  };
}

// --- slicing ---------------------------------------------------------------

function runSlicer(inputPath, outputPath) {
  return new Promise((resolve) => {
    const child = spawn(
      PRUSA_BIN,
      [
        "--export-gcode",
        "--load",
        CONFIG,
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
    const result = await runSlicer(inputPath, outputPath);
    if (result.timedOut) {
      return { status: 422, body: { ok: false, error: "slicing timed out" } };
    }
    if (result.code !== 0) {
      return { status: 422, body: { ok: false, error: errorLine(result.output) } };
    }
    const stats = parseGcodeStats(await readTail(outputPath));
    if (stats.printTimeSeconds == null) {
      return {
        status: 422,
        body: { ok: false, error: "no print time in slicer output" },
      };
    }
    return { status: 200, body: { ok: true, ...stats } };
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
