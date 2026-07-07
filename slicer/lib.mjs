// Pure helpers for the slicer service: G-code stats parsing and translation
// of settings embedded in a .3mf into whitelisted PrusaSlicer config keys.
// Kept free of I/O so `npm test` (in the repo root) can cover them; server.mjs
// wires them to HTTP + the PrusaSlicer CLI.

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

export function parseGcodeStats(tail) {
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

// The extruder most objects are assigned to (1-based; 1 when unspecified).
export function usedExtruder(modelSettingsXml) {
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

export function fromBambuJson(settings, extruder) {
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

export function fromPrusaIni(ini) {
  const derived = {};
  for (const line of ini.split("\n")) {
    const m = line.match(/^\s*([a-z_0-9]+)\s*=\s*(.*)$/);
    if (!m || !PRUSA_KEY_WHITELIST.has(m[1])) continue;
    const value = cleanValue(m[1], m[2]);
    if (value !== null) derived[m[1]] = value;
  }
  return derived;
}
