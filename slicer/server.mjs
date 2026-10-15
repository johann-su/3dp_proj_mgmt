// Thin HTTP wrapper around the OrcaSlicer CLI. Zero npm dependencies so the
// container is just ubuntu + the extracted OrcaSlicer AppImage + nodejs +
// unzip/zip. The pure parsing, planning and config-translation helpers live
// in lib.mjs (unit-tested via `npm test` in the repo root).
//
//   GET  /healthz    liveness probe
//   POST /estimate   body = raw .3mf bytes
//     -> 200 { ok: true, printTimeSeconds, filamentGrams, filamentMm, profile,
//              engine, printer, plateFilaments, repairedSettings, approx }
//     -> 422 { ok: false, error }   file could not be sliced (unslicable)
//     -> 413/500 on oversize body / unexpected errors
//
// How a file is sliced depends on what it carries:
//
// - Bambu Studio / OrcaSlicer projects (Metadata/project_settings.config) are
//   sliced natively with their own printer, process and filament settings and
//   their own plate layout — the same engine that produced them, so the
//   estimate matches what the slicer would show. `profile` = "file".
// - PrusaSlicer projects (Metadata/Slic3r_PE.config, which Orca ignores) are
//   sliced with the generic profile plus the known settings — including the
//   project's bed — translated into Orca CLI overrides. `profile` = "file"
//   when any setting carried over.
// - Anything else is sliced with the generic profile: an Orca system preset
//   set chosen by SLICER_GENERIC_* (see presets.mjs). `profile` = "generic".
//
// `approx` is false only when the file was sliced exactly as its own slicer
// would: a Bambu/Orca project, natively, with nothing repaired. Generic-printer,
// translated-PrusaSlicer and repaired slices rest on assumptions the file
// didn't make, so the app marks them as approximate ("~").
// `printer` names the printer the estimate was computed for; a model that
// doesn't fit its bed fails with that printer named. `plateFilaments` lists
// each sliced plate's filament types (more than one = filament changes
// mid-print). `repairedSettings` lists project settings changed so a project
// from a newer Bambu Studio would slice (see repairSettings in lib.mjs).
//
// The CLI never runs post-processing scripts (upstream has the call commented
// out); project settings that name one are stripped only because the CLI
// otherwise rejects the whole file.
//
// Slicing is CPU-bound, so requests are processed one at a time.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describePrinter,
  estimateIsApprox,
  parseResultJson,
  parseSliceInfo,
  platesToSlice,
  projectPlates,
  prusaIniToOrca,
  prusaPrinterName,
  repairSettings,
  stripPostProcess,
  toCliFlags,
  usedExtruder,
} from "./lib.mjs";
import { buildGenericPresets } from "./presets.mjs";

const PORT = Number(process.env.PORT ?? 8000);
const ORCA_BIN = process.env.ORCA_SLICER_BIN ?? "/opt/orca/AppRun";
const PROFILES_DIR = process.env.ORCA_PROFILES ?? "/opt/orca/resources/profiles";
const TIMEOUT_MS = Number(process.env.SLICE_TIMEOUT_MS ?? 300_000);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 256 * 1024 * 1024);
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
// Each repair round fixes what one CLI run reports; a newer Bambu Studio
// project has needed three (out-of-range values, then two G-code rounds).
const MAX_REPAIR_ROUNDS = 5;

// CLI return codes (`cli_errors` in OrcaSlicer's src/OrcaSlicer.cpp).
const CLI_INVALID_VALUES_IN_3MF = -18;
const CLI_NO_SUITABLE_OBJECTS = -50; // a plate with no object fully inside it
const CLI_SLICING_ERROR = -100; // includes custom G-code that doesn't parse

const PRESETS_DIR = await mkdtemp(join(tmpdir(), "presets-"));
const GENERIC_MACHINE = buildGenericPresets({
  profilesDir: PROFILES_DIR,
  outDir: PRESETS_DIR,
  machine: process.env.SLICER_GENERIC_MACHINE || "Bambu Lab P1S 0.4 nozzle",
  process: process.env.SLICER_GENERIC_PROCESS || "0.20mm Standard @BBL X1C",
  filament: process.env.SLICER_GENERIC_FILAMENT || "Bambu PLA Basic @BBL X1C",
});

const GENERIC_ARGS = [
  "--load-settings",
  `${join(PRESETS_DIR, "machine.json")};${join(PRESETS_DIR, "process.json")}`,
  "--load-filaments",
  join(PRESETS_DIR, "filament.json"),
  // No plate layout to honor: place the objects on the bed.
  "--arrange",
  "1",
];

// --- archive access ----------------------------------------------------------

function run(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    const chunks = [];
    let size = 0;
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_ENTRY_BYTES) chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.on("error", (err) => resolve({ code: null, stdout: null, stderr: String(err) }));
    child.on("exit", (code) =>
      resolve({
        code,
        stdout: size <= MAX_ENTRY_BYTES ? Buffer.concat(chunks) : null,
        stderr,
      }),
    );
  });
}

async function unzipEntry(archivePath, entryName) {
  const { code, stdout } = await run("unzip", ["-p", archivePath, entryName]);
  return code === 0 ? stdout : null;
}

// Replaces Metadata/project_settings.config inside the archive.
async function writeProjectSettings(inputPath, dir, settings) {
  await mkdir(join(dir, "Metadata"), { recursive: true });
  await writeFile(
    join(dir, "Metadata", "project_settings.config"),
    JSON.stringify(settings, null, 4),
  );
  // zip replaces the entry in place; run from `dir` so it keeps its path.
  const { code, stderr } = await run(
    "zip",
    ["-q", inputPath, "Metadata/project_settings.config"],
    { cwd: dir },
  );
  if (code !== 0) throw new Error(`could not rewrite project settings: ${stderr}`);
}

// --- planning ------------------------------------------------------------------

// Decides how to slice the archive. May rewrite the archive in place (to
// strip post-processing scripts from Bambu/Orca project settings).
async function planSlice(inputPath, dir) {
  const projectSettings = await unzipEntry(
    inputPath,
    "Metadata/project_settings.config",
  );
  let settings = null;
  try {
    settings = projectSettings ? JSON.parse(projectSettings.toString("utf8")) : null;
  } catch {
    // not JSON — not a Bambu/Orca project
  }
  if (settings) {
    const stripped = stripPostProcess(settings);
    if (stripped) {
      settings = stripped;
      await writeProjectSettings(inputPath, dir, settings);
    }
    const modelSettings = await unzipEntry(inputPath, "Metadata/model_settings.config");
    const plates = projectPlates(modelSettings?.toString("utf8") ?? "");
    return {
      profile: "file",
      args: [],
      settings, // repairable: the archive's own settings
      printer: describePrinter(settings),
      runs: plates.length ? platesToSlice(plates) : [0],
      skippedPlates: plates.filter((p) => p.instances === 0).length,
    };
  }

  const prusaIni = await unzipEntry(inputPath, "Metadata/Slic3r_PE.config");
  if (prusaIni) {
    const ini = prusaIni.toString("utf8");
    const modelConfig = await unzipEntry(inputPath, "Metadata/Slic3r_PE_model.config");
    const overrides = prusaIniToOrca(ini, usedExtruder(modelConfig?.toString("utf8") ?? ""));
    if (Object.keys(overrides).length > 0) {
      return {
        profile: "file",
        translated: true, // PrusaSlicer settings mapped onto Orca's
        args: [...GENERIC_ARGS, ...toCliFlags(overrides)],
        settings: null,
        // The project's printer and bed where it names them, else the
        // generic machine's.
        printer: describePrinter({
          ...GENERIC_MACHINE,
          ...overrides,
          ...(prusaPrinterName(ini) && {
            printer_model: prusaPrinterName(ini).replace(/ \d+(\.\d+)? nozzle$/, ""),
          }),
        }),
        runs: [0],
        skippedPlates: 0,
      };
    }
  }
  return {
    profile: "generic",
    args: GENERIC_ARGS,
    settings: null,
    printer: describePrinter(GENERIC_MACHINE),
    runs: [0],
    skippedPlates: 0,
  };
}

// --- slicing -------------------------------------------------------------------

function runOrca(args, cwd) {
  return new Promise((resolve) => {
    // Orca writes a log file into its working directory and unpacks models
    // under $TMPDIR — keep both in the per-request temp dir so they're
    // cleaned up with everything else.
    const child = spawn(ORCA_BIN, args, {
      cwd,
      env: { ...process.env, TMPDIR: cwd },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Keep the tail: the lines that explain a failure come last.
    let output = "";
    const collect = (chunk) => {
      output = (output + chunk).slice(-64 * 1024);
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

// Last meaningful line of the slicer output, for failures without a
// result.json (e.g. a crash). Temp paths mean nothing to the caller.
function errorLine(output) {
  const lines = output
    .split("\n")
    .map((l) => l.trim().replace(/\/tmp\/slice-[^\s:]*:?\s*/g, ""))
    .filter((l) => l && !/XDG_RUNTIME_DIR/.test(l));
  return lines.at(-1) ?? "slicing produced no output";
}

// Slices `plate` (0 = all) and returns the parsed slice_info of the output,
// or the CLI's failure.
async function slicePlate(plan, inputPath, dir, plate) {
  const outDir = join(dir, `out-${plate}`);
  // Must exist up front: on early failures the CLI writes result.json
  // without creating the directory first.
  await mkdir(outDir, { recursive: true });
  const result = await runOrca(
    [
      ...plan.args,
      // A project saved by a newer Bambu Studio/Orca than this CLI is still
      // worth trying; the version check would otherwise flag it unsliceable.
      "--allow-newer-file=1",
      "--min-save=1",
      "--slice",
      String(plate),
      "--outputdir",
      outDir,
      "--export-3mf",
      "result.3mf",
      inputPath,
    ],
    dir,
  );
  if (result.timedOut) return { ok: false, error: "slicing timed out" };

  const status = parseResultJson(
    await readFile(join(outDir, "result.json"), "utf8").catch(() => ""),
  );
  if (result.code !== 0 || (status && status.returnCode !== 0)) {
    const plateIndex = status?.plateIndex || plate;
    let error = status?.error || errorLine(result.output);
    // Empty plates were skipped up front, so this means objects that don't
    // fit the bed — name the printer instead of the CLI's upload advice.
    if (status?.returnCode === CLI_NO_SUITABLE_OBJECTS) {
      error = `doesn't fit on the ${plan.printer}`;
    }
    return {
      ok: false,
      returnCode: status?.returnCode ?? null,
      output: result.output,
      error: plateIndex > 0 ? `plate ${plateIndex}: ${error}` : error,
    };
  }
  const sliceInfo = await unzipEntry(
    join(outDir, "result.3mf"),
    "Metadata/slice_info.config",
  );
  if (!sliceInfo) return { ok: false, error: errorLine(result.output) };
  return { ok: true, info: parseSliceInfo(sliceInfo.toString("utf8")) };
}

// slicePlate, plus repairs of a project's settings when the CLI rejects
// values a newer Bambu Studio wrote (see repairSettings).
async function slicePlateRepairing(plan, inputPath, dir, plate, repaired) {
  for (let round = 0; ; round++) {
    const sliced = await slicePlate(plan, inputPath, dir, plate);
    const repairable =
      sliced.returnCode === CLI_INVALID_VALUES_IN_3MF ||
      sliced.returnCode === CLI_SLICING_ERROR;
    if (sliced.ok || !plan.settings || !repairable || round >= MAX_REPAIR_ROUNDS) {
      return sliced;
    }
    const repair = repairSettings(plan.settings, sliced.output);
    if (!repair) return sliced;
    plan.settings = repair.settings;
    for (const key of repair.keys) repaired.add(key);
    await writeProjectSettings(inputPath, dir, plan.settings);
  }
}

async function estimate(body) {
  const dir = await mkdtemp(join(tmpdir(), "slice-"));
  const inputPath = join(dir, "input.3mf");
  try {
    await writeFile(inputPath, body);
    const plan = await planSlice(inputPath, dir);
    if (plan.runs.length === 0) {
      return { status: 422, body: { ok: false, error: "all plates are empty" } };
    }

    const totals = { printTimeSeconds: null, filamentGrams: null, filamentMm: null };
    const plateFilaments = [];
    const repaired = new Set();
    let engine = null;
    for (const plate of plan.runs) {
      const sliced = await slicePlateRepairing(plan, inputPath, dir, plate, repaired);
      if (!sliced.ok) return { status: 422, body: { ok: false, error: sliced.error } };
      for (const key of Object.keys(totals)) {
        if (sliced.info[key] != null) totals[key] = (totals[key] ?? 0) + sliced.info[key];
      }
      plateFilaments.push(...sliced.info.plateFilaments);
      engine ??= sliced.info.engine;
    }
    if (totals.printTimeSeconds == null) {
      return {
        status: 422,
        body: { ok: false, error: "no print time in slicer output" },
      };
    }
    for (const key of ["filamentGrams", "filamentMm"]) {
      if (totals[key] != null) totals[key] = Math.round(totals[key] * 100) / 100;
    }
    console.log(
      `sliced ${body.length}B profile=${plan.profile} printer="${plan.printer}" ` +
        `translated=${Boolean(plan.translated)} runs=${plan.runs.join(",")} ` +
        `skippedEmptyPlates=${plan.skippedPlates} ` +
        `repaired=${[...repaired].join(",") || "-"} time=${totals.printTimeSeconds}s ` +
        `filament=${totals.filamentGrams}g`,
    );
    return {
      status: 200,
      body: {
        ok: true,
        profile: plan.profile,
        engine,
        printer: plan.printer,
        ...totals,
        plateFilaments,
        repairedSettings: [...repaired],
        approx: estimateIsApprox({ ...plan, repairedKeys: [...repaired] }),
      },
    };
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
  console.log(
    `slicer service listening on :${PORT} (generic printer: ${describePrinter(GENERIC_MACHINE)})`,
  );
});
