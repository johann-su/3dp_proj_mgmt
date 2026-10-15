// Pure helpers for the slicer service: reading OrcaSlicer's results, planning
// a slice from what the uploaded .3mf carries, translating PrusaSlicer project
// settings into OrcaSlicer CLI overrides, and flattening Orca's system presets
// into the generic profile. Kept free of I/O so `npm test` (in the repo root)
// can cover them; server.mjs wires them to HTTP + the OrcaSlicer CLI, and
// presets.mjs runs the flattening at startup.

// --- OrcaSlicer CLI results --------------------------------------------------

// The CLI writes result.json into --outputdir on success *and* failure:
// { return_code, error_string, plate_index (1-based, 0 = not plate-specific) }
// — codes and messages are `cli_errors` in OrcaSlicer's src/OrcaSlicer.cpp.
export function parseResultJson(text) {
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof result?.return_code !== "number") return null;
  return {
    returnCode: result.return_code,
    error: typeof result.error_string === "string" ? result.error_string : "",
    plateIndex: Number.isInteger(result.plate_index) ? result.plate_index : 0,
  };
}

// Metadata/slice_info.config of the sliced output: one <plate> per sliced
// plate with <metadata key="prediction"> (seconds) and key="weight" (grams),
// plus a <filament type used_m used_g> per filament the plate prints from.
// Totals are summed over plates; `plateFilaments` keeps each plate's filament
// types, since one plate is one print — more than one there means filament
// changes mid-print (an AMS/MMU), unlike plates that each use another filament.
// `weight` can be empty when the filament preset has no density; fall back to
// the per-filament grams then.
export function parseSliceInfo(xml) {
  let printTimeSeconds = null;
  let filamentGrams = null;
  let filamentMm = null;
  let plates = 0;
  const plateFilaments = [];
  for (const [, plate] of xml.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
    plates++;
    plateFilaments.push(
      [...plate.matchAll(/<filament\b[^>]*>/g)].map(([tag]) => attribute(tag, "type")),
    );
    const prediction = Number.parseFloat(metadataValue(plate, "prediction"));
    if (Number.isFinite(prediction)) {
      printTimeSeconds = (printTimeSeconds ?? 0) + prediction;
    }
    let grams = Number.parseFloat(metadataValue(plate, "weight"));
    let metres = null;
    let filamentGramsSum = null;
    for (const [tag] of plate.matchAll(/<filament\b[^>]*>/g)) {
      const m = Number.parseFloat(attribute(tag, "used_m"));
      const g = Number.parseFloat(attribute(tag, "used_g"));
      if (Number.isFinite(m)) metres = (metres ?? 0) + m;
      if (Number.isFinite(g)) filamentGramsSum = (filamentGramsSum ?? 0) + g;
    }
    if (!(grams > 0)) grams = filamentGramsSum > 0 ? filamentGramsSum : NaN;
    if (Number.isFinite(grams)) filamentGrams = (filamentGrams ?? 0) + grams;
    if (metres != null) filamentMm = (filamentMm ?? 0) + metres * 1000;
  }
  return {
    plates,
    plateFilaments,
    engine: sliceEngine(xml),
    printTimeSeconds:
      printTimeSeconds == null ? null : Math.round(printTimeSeconds),
    filamentGrams: filamentGrams == null ? null : round2(filamentGrams),
    filamentMm: filamentMm == null ? null : round2(filamentMm),
  };
}

// The slicer that wrote a slice_info.config, from its <header>: OrcaSlicer adds
// its own version item; Bambu Studio only writes the X-BBL client version
// (which Orca also copies over from the project, so it must be checked last).
export function sliceEngine(xml) {
  const orca = headerItem(xml, "OrcaSlicer-Version");
  if (orca) return `OrcaSlicer ${orca}`;
  const bambu = headerItem(xml, "X-BBL-Client-Version");
  return bambu ? `Bambu Studio ${bambu}` : null;
}

function headerItem(xml, key) {
  const m = xml.match(new RegExp(`<header_item key="${key}" value="([^"]*)"`));
  return m?.[1] || null;
}

function metadataValue(xml, key) {
  const m = xml.match(new RegExp(`<metadata key="${key}" value="([^"]*)"`));
  return m ? m[1] : "";
}

function attribute(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : "";
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// --- Bambu/Orca projects ----------------------------------------------------

// The plates of a Bambu/Orca project (Metadata/model_settings.config) with
// how many object instances sit on each. Empty plates are common (a plate
// added and never filled) and make `--slice 0` fail outright (CLI return
// code -50, "One of the plate is empty").
export function projectPlates(modelSettingsXml) {
  const plates = [];
  for (const [, block] of modelSettingsXml.matchAll(
    /<plate>([\s\S]*?)<\/plate>/g,
  )) {
    const index = Number.parseInt(metadataValue(block, "plater_id"), 10);
    if (!Number.isInteger(index) || index < 1) continue;
    const instances = block.match(/<model_instance>/g)?.length ?? 0;
    plates.push({ index, instances });
  }
  return plates;
}

// Which `--slice` runs a project needs: one run over all plates (0), or —
// when some plates are empty — one run per non-empty plate.
export function platesToSlice(plates) {
  if (!plates.some((p) => p.instances === 0)) return [0];
  return plates.filter((p) => p.instances > 0).map((p) => p.index);
}

// The CLI refuses a project whose settings carry post-processing scripts
// ("post_process is not supported under CLI") — it never runs them, but the
// file would be flagged unsliceable for a setting that doesn't affect the
// estimate. Returns the settings with the scripts removed, or null when
// there is nothing to strip.
export function stripPostProcess(settings) {
  const scripts = settings?.post_process;
  const hasScripts = Array.isArray(scripts)
    ? scripts.some((s) => String(s).trim() !== "")
    : typeof scripts === "string" && scripts.trim() !== "";
  if (!hasScripts) return null;
  return { ...settings, post_process: [] };
}

// Projects saved by a newer Bambu Studio than the bundled Orca knows can carry
// values Orca rejects. The CLI reports each problem on its own line, and two
// kinds are safe to repair because they barely touch the estimate:
//
// - `raft_first_layer_expansion: -1 not in range [0,…]` (return code -18):
//   newer "auto" sentinels — dropping the key lets Orca use its default.
// - `machine_start_gcode Parsing error at line 57: …` (return code -100):
//   custom G-code using placeholders Orca doesn't have — blanked. Note this
//   also drops the moves that G-code would add; for change_filament_gcode on
//   multi-colour prints that means the purge/swap time is missing, which is
//   why the service reports what it repaired.
//
// Error keys are Orca's names, which can differ from the project's only by
// underscores (Orca `timelapse_gcode`, Bambu `time_lapse_gcode`). Returns the
// repaired settings and the keys touched, or null when nothing applies.
export function repairSettings(settings, cliOutput) {
  const outOfRange = [...cliOutput.matchAll(/^\s*(\w+): .* not in range/gm)].map((m) => m[1]);
  const badGcode = [...cliOutput.matchAll(/^\s*(\w+_gcode) Parsing error/gm)].map((m) => m[1]);
  const squash = (key) => key.replaceAll("_", "");
  const repaired = { ...settings };
  const touched = [];
  for (const errorKey of [...outOfRange, ...badGcode]) {
    const isGcode = badGcode.includes(errorKey);
    for (const key of Object.keys(repaired)) {
      if (squash(key) !== squash(errorKey)) continue;
      if (isGcode) {
        const value = repaired[key];
        if (Array.isArray(value) ? value.every((v) => v === "") : value === "") continue;
        repaired[key] = Array.isArray(value) ? value.map(() => "") : "";
      } else {
        delete repaired[key];
      }
      touched.push(key);
    }
  }
  return touched.length ? { settings: repaired, keys: touched } : null;
}

// "Bambu Lab P1S (256 × 256 × 256 mm)" from Orca machine settings, for
// telling the user which printer a model doesn't fit on.
export function describePrinter(settings) {
  const name =
    settings.printer_model ||
    String(settings.printer_settings_id || settings.name || "printer").replace(
      / \d+(\.\d+)? nozzle$/,
      "",
    );
  const points = (Array.isArray(settings.printable_area)
    ? settings.printable_area
    : String(settings.printable_area ?? "").split(",")
  )
    .map((p) => String(p).split("x").map(Number))
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const height = Number.parseFloat(settings.printable_height);
  if (points.length < 3 || !(height > 0)) return name;
  const span = (i) =>
    Math.round(Math.max(...points.map((p) => p[i])) - Math.min(...points.map((p) => p[i])));
  return `${name} (${span(0)} × ${span(1)} × ${Math.round(height)} mm)`;
}

// Whether an estimate is approximate — i.e. not what the file's own slicer
// would report. Only a Bambu/Orca project sliced natively with nothing
// repaired is exact (within 0.1% of Bambu Studio on a real project); the
// generic printer, translated PrusaSlicer settings and repaired settings
// (which can drop filament-change time) are all assumptions the file didn't
// make.
export function estimateIsApprox({ profile, translated = false, repairedCount = 0 }) {
  return profile === "generic" || translated || repairedCount > 0;
}

// --- PrusaSlicer projects -> OrcaSlicer CLI overrides ------------------------

// OrcaSlicer ignores Metadata/Slic3r_PE.config, so PrusaSlicer projects slice
// with the generic profile plus these settings translated to Orca's keys and
// passed as CLI flags (which take priority over the loaded presets).
// Scalar print settings, PrusaSlicer key -> Orca key:
const PRUSA_SCALAR_MAP = {
  layer_height: "layer_height",
  first_layer_height: "initial_layer_print_height",
  perimeters: "wall_loops",
  top_solid_layers: "top_shell_layers",
  bottom_solid_layers: "bottom_shell_layers",
  fill_density: "sparse_infill_density",
  support_material: "enable_support",
  brim_width: "brim_width",
  skirts: "skirt_loops",
  travel_speed: "travel_speed",
  external_perimeter_speed: "outer_wall_speed",
  perimeter_speed: "inner_wall_speed",
  infill_speed: "sparse_infill_speed",
  solid_infill_speed: "internal_solid_infill_speed",
  top_solid_infill_speed: "top_surface_speed",
  first_layer_speed: "initial_layer_speed",
  gap_fill_speed: "gap_infill_speed",
  bridge_speed: "bridge_speed",
  default_acceleration: "default_acceleration",
  first_layer_acceleration: "initial_layer_acceleration",
  external_perimeter_acceleration: "outer_wall_acceleration",
  perimeter_acceleration: "inner_wall_acceleration",
  infill_acceleration: "sparse_infill_acceleration",
  solid_infill_acceleration: "internal_solid_infill_acceleration",
  top_solid_infill_acceleration: "top_surface_acceleration",
  travel_acceleration: "travel_acceleration",
};

// Per-extruder lists in PrusaSlicer; the generic profile has one extruder and
// one filament, so these take the entry of the extruder the objects use.
const PRUSA_PER_EXTRUDER_MAP = {
  filament_diameter: "filament_diameter",
  filament_density: "filament_density",
  filament_type: "filament_type",
  temperature: "nozzle_temperature",
  first_layer_temperature: "nozzle_temperature_initial_layer",
  filament_max_volumetric_speed: "filament_max_volumetric_speed",
  nozzle_diameter: "nozzle_diameter",
};

// Machine kinematics: [normal, silent] lists with the same key names in both
// slicers. These dominate the time estimate on fast printers.
const MACHINE_LIMIT_KEYS = [
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

// PrusaSlicer fill pattern -> Orca sparse_infill_pattern. Orca calls
// rectilinear "zig-zag" and stars "tri-hexagon"; the rest share names.
const FILL_PATTERNS = {
  rectilinear: "zig-zag",
  stars: "tri-hexagon",
  ...Object.fromEntries(
    [
      "alignedrectilinear", "grid", "triangles", "cubic", "line",
      "concentric", "honeycomb", "3dhoneycomb", "gyroid", "hilbertcurve",
      "archimedeanchords", "octagramspiral", "adaptivecubic", "supportcubic",
      "lightning",
    ].map((p) => [p, p]),
  ),
};

// Only plain numbers/words/lists survive — values become CLI arguments, and
// a crafted archive should not be able to smuggle anything else in.
const SAFE_VALUE = /^[A-Za-z0-9.,+-]{1,200}$/;

function cleanValue(raw) {
  const value = String(raw).trim();
  return SAFE_VALUE.test(value) ? value : null;
}

function parseIni(ini) {
  const values = {};
  for (const line of ini.split("\n")) {
    const m = line.match(/^\s*([a-z_0-9]+)\s*=\s*(.*?)\s*$/);
    if (m) values[m[1]] = m[2];
  }
  return values;
}

// The printer a PrusaSlicer project was set up for ("Original Prusa MK4S 0.4
// nozzle"), or null.
export function prusaPrinterName(ini) {
  const name = parseIni(ini).printer_settings_id?.replace(/^"|"$/g, "").trim();
  return name || null;
}

// Returns Orca setting key -> value for the settings a PrusaSlicer project
// defines. Unknown keys (post_process, print_host, …) are never copied.
export function prusaIniToOrca(ini, extruder = 1) {
  const prusa = parseIni(ini);
  const orca = {};
  const set = (key, raw) => {
    if (raw == null) return;
    const value = cleanValue(raw);
    if (value !== null) orca[key] = value;
  };

  for (const [prusaKey, orcaKey] of Object.entries(PRUSA_SCALAR_MAP)) {
    const raw = prusa[prusaKey];
    if (raw == null) continue;
    // PrusaSlicer allows "50%" for many speeds (relative to another speed);
    // Orca accepts a percentage only for the infill density.
    if (raw.includes("%")) {
      if (orcaKey === "sparse_infill_density") {
        const pct = raw.replace(/\s/g, "");
        if (/^\d+(\.\d+)?%$/.test(pct)) orca[orcaKey] = pct;
      }
      continue;
    }
    set(orcaKey, raw);
  }
  for (const [prusaKey, orcaKey] of Object.entries(PRUSA_PER_EXTRUDER_MAP)) {
    const raw = prusa[prusaKey];
    if (raw == null) continue;
    const entries = raw.split(/[,;]/).map((s) => s.trim());
    set(orcaKey, entries[extruder - 1] ?? entries[0]);
  }
  for (const key of MACHINE_LIMIT_KEYS) set(key, prusa[key]);
  // The project's own bed, so "doesn't fit" refers to the printer the project
  // was set up for. Same "0x0,250x0,…" point list in both slicers.
  if (/^(-?\d+(\.\d+)?x-?\d+(\.\d+)?,){2,}-?\d+(\.\d+)?x-?\d+(\.\d+)?$/.test(prusa.bed_shape?.replace(/\s/g, "") ?? "")) {
    orca.printable_area = prusa.bed_shape.replace(/\s/g, "");
  }
  set("printable_height", prusa.max_print_height);

  const pattern = FILL_PATTERNS[prusa.fill_pattern?.trim()];
  if (pattern) orca.sparse_infill_pattern = pattern;
  return orca;
}

// The extruder most objects are assigned to (1-based; 1 when unspecified).
// Works on PrusaSlicer's Slic3r_PE_model.config, where `value="0"` on a part
// means "inherit the object's extruder" and is therefore not counted.
export function usedExtruder(modelConfigXml) {
  const counts = new Map();
  for (const m of modelConfigXml.matchAll(
    /key="extruder"\s+value="(\d+)"/g,
  )) {
    if (m[1] === "0") continue;
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  let best = 1;
  let bestCount = 0;
  for (const [extruder, count] of counts) {
    if (count > bestCount) [best, bestCount] = [Number(extruder), count];
  }
  return best;
}

// Orca setting map -> CLI flags. Orca's CLI spells every setting with dashes
// (`layer_height` -> `--layer-height`) and accepts `--flag=value`.
export function toCliFlags(settings) {
  return Object.entries(settings).map(
    ([key, value]) => `--${key.replaceAll("_", "-")}=${value}`,
  );
}

// --- generic profile (flattened system presets) ------------------------------

// OrcaSlicer's system presets inherit from base presets (`inherits`), but the
// CLI's --load-settings reads a preset file as-is and never resolves that
// chain — values only defined on a base (filament density, speeds, the start
// G-code, …) would silently fall back to the engine's defaults. So presets
// are flattened at build time. `lookup(name)` returns the parsed preset JSON.
export function flattenPreset(name, lookup) {
  const chain = [];
  const seen = new Set();
  for (let current = name; current; ) {
    if (seen.has(current)) throw new Error(`inherits cycle at "${current}"`);
    seen.add(current);
    const preset = lookup(current);
    if (!preset) throw new Error(`preset "${current}" not found`);
    chain.unshift(preset);
    current = preset.inherits;
  }
  const flat = Object.assign({}, ...chain);
  delete flat.inherits;
  flat.name = name;
  return flat;
}

// Turns flattened presets into a set the CLI accepts together: loaded as
// "system" presets, the process (and filament) must list the machine in
// compatible_printers or the CLI refuses the combination ("The selected
// printer is not compatible with the process preset"). The machine keeps its
// real bed: a model too big for it is reported as not fitting that printer,
// which the model page names.
export function genericPresetSet({ machine, process, filament }) {
  const compat = (preset) => {
    const out = { ...preset, from: "system", compatible_printers: [machine.name] };
    delete out.compatible_printers_condition;
    delete out.compatible_prints;
    delete out.compatible_prints_condition;
    return out;
  };
  return {
    machine: { ...machine, from: "system" },
    process: compat(process),
    filament: compat(filament),
  };
}
