// Thin HTTP wrapper around the PrusaSlicer CLI. Zero npm dependencies so the
// container is just debian + prusa-slicer + nodejs + unzip.
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

// --- embedded settings -> derived PrusaSlicer config -----------------------

// Bambu Studio / OrcaSlicer keys (Metadata/project_settings.config) mapped to
// their PrusaSlicer equivalents. Scalar process settings:
const BAMBU_SCALAR_MAP = {
  layer_height: "layer_height",
  initial_layer_print_height: "first_layer_height",
  wall_loops: "perimeters",
  top_shell_layers: "top_solid_layers",
  bottom_shell_layers: "bottom_solid_layers",
  sparse_infill_density: "fill_density",
  enable_support: "support_material",
  brim_width: "brim_width",
  skirt_loops: "skirts",
  travel_speed: "travel_speed",
  outer_wall_speed: "external_perimeter_speed",
  inner_wall_speed: "perimeter_speed",
  sparse_infill_speed: "infill_speed",
  internal_solid_infill_speed: "solid_infill_speed",
  top_surface_speed: "top_solid_infill_speed",
  initial_layer_speed: "first_layer_speed",
  gap_infill_speed: "gap_fill_speed",
  bridge_speed: "bridge_speed",
  default_acceleration: "default_acceleration",
  initial_layer_acceleration: "first_layer_acceleration",
  outer_wall_acceleration: "external_perimeter_acceleration",
  inner_wall_acceleration: "perimeter_acceleration",
  sparse_infill_acceleration: "infill_acceleration",
  internal_solid_infill_acceleration: "solid_infill_acceleration",
  top_surface_acceleration: "top_solid_infill_acceleration",
  travel_acceleration: "travel_acceleration",
};

// Per-filament arrays, indexed by the extruder the objects actually use
// (model_settings.config) — an AMS project may park 5 filaments while the
// plate prints with one.
const BAMBU_FILAMENT_MAP = {
  filament_diameter: "filament_diameter",
  filament_density: "filament_density",
  filament_type: "filament_type",
  nozzle_temperature: "temperature",
  nozzle_temperature_initial_layer: "first_layer_temperature",
};

// Machine kinematics: arrays of [normal, silent] values, joined for
// PrusaSlicer's vector syntax. These dominate the time estimate on fast
// printers, so they matter more than the speed settings themselves.
const BAMBU_MACHINE_KEYS = [
  "machine_max_speed_x",
  "machine_max_speed_y",
  "machine_max_speed_z",
  "machine_max_speed_e",
  "machine_max_acceleration_x",
  "machine_max_acceleration_y",
  "machine_max_acceleration_z",
  "machine_max_acceleration_e",
  "machine_max_acceleration_extruding",
  "machine_max_acceleration_travel",
  "machine_max_acceleration_retracting",
  "machine_max_jerk_x",
  "machine_max_jerk_y",
  "machine_max_jerk_z",
  "machine_max_jerk_e",
];

// nozzle_diameter is per-extruder in Bambu configs; joined like machine keys.
const BAMBU_VECTOR_MAP = Object.fromEntries([
  ...BAMBU_MACHINE_KEYS.map((k) => [k, k]),
  ["nozzle_diameter", "nozzle_diameter"],
]);

const FILL_PATTERNS = new Set([
  "rectilinear", "alignedrectilinear", "grid", "triangles", "stars", "cubic",
  "line", "concentric", "honeycomb", "3dhoneycomb", "gyroid", "hilbertcurve",
  "archimedeanchords", "octagramspiral", "adaptivecubic", "supportcubic",
  "lightning",
]);
const BAMBU_FILL_ALIASES = { "zig-zag": "rectilinear" };

// Every PrusaSlicer key a derived config may set; doubles as the whitelist
// for embedded PrusaSlicer inis. Intentionally excludes anything that could
// touch the system (post_process, print_host, …), output paths, and the bed
// (see ESTIMATION-BED note in config.ini).
const PRUSA_KEY_WHITELIST = new Set([
  ...Object.values(BAMBU_SCALAR_MAP),
  ...Object.values(BAMBU_FILAMENT_MAP),
  ...Object.values(BAMBU_VECTOR_MAP),
  "fill_pattern",
]);

// Percent values are only universally accepted here; elsewhere they can make
// prusa-slicer reject the whole config, which would fail the slice.
const PERCENT_OK = new Set([
  "fill_density", "external_perimeter_speed", "solid_infill_speed",
  "top_solid_infill_speed", "first_layer_speed",
]);

function cleanValue(prusaKey, raw) {
  const value = String(raw).trim();
  if (!/^[A-Za-z0-9. ,%+-]{1,200}$/.test(value)) return null;
  if (value.includes("%") && !PERCENT_OK.has(prusaKey)) return null;
  return value;
}

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

// The extruder most objects are assigned to (1-based; 1 when unspecified).
function usedExtruder(modelSettingsXml) {
  const counts = new Map();
  for (const m of modelSettingsXml.matchAll(
    /key="extruder"\s+value="(\d+)"/g,
  )) {
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  let best = 1;
  let bestCount = 0;
  for (const [extruder, count] of counts) {
    if (count > bestCount) [best, bestCount] = [Number(extruder), count];
  }
  return best;
}

function fromBambuJson(settings, extruder) {
  const derived = {};
  const set = (prusaKey, raw) => {
    if (raw == null) return;
    const value = cleanValue(prusaKey, raw);
    if (value !== null) derived[prusaKey] = value;
  };
  for (const [key, prusaKey] of Object.entries(BAMBU_SCALAR_MAP)) {
    set(prusaKey, settings[key]);
  }
  for (const [key, prusaKey] of Object.entries(BAMBU_VECTOR_MAP)) {
    if (Array.isArray(settings[key])) set(prusaKey, settings[key].join(","));
  }
  const index = extruder - 1;
  for (const [key, prusaKey] of Object.entries(BAMBU_FILAMENT_MAP)) {
    if (Array.isArray(settings[key])) set(prusaKey, settings[key][index]);
  }
  const pattern = BAMBU_FILL_ALIASES[settings.sparse_infill_pattern] ??
    settings.sparse_infill_pattern;
  if (FILL_PATTERNS.has(pattern)) derived.fill_pattern = pattern;
  return derived;
}

function fromPrusaIni(ini) {
  const derived = {};
  for (const line of ini.split("\n")) {
    const m = line.match(/^\s*([a-z_0-9]+)\s*=\s*(.*)$/);
    if (!m || !PRUSA_KEY_WHITELIST.has(m[1])) continue;
    const value = cleanValue(m[1], m[2]);
    if (value !== null) derived[m[1]] = value;
  }
  return derived;
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
    const stats = parseGcodeStats(await readTail(outputPath));
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
