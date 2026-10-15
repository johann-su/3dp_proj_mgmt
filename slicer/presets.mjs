// Builds the generic profile at startup from OrcaSlicer's bundled system
// presets, so a self-hoster picks the printer that files without slicer
// settings are estimated for (SLICER_GENERIC_* env vars) without rebuilding
// the image. The CLI doesn't resolve preset inheritance, so the presets are
// flattened here (flattenPreset/genericPresetSet in lib.mjs) and written to
// disk for --load-settings.

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { flattenPreset, genericPresetSet } from "./lib.mjs";

// Shared filament presets ("Generic PLA @System", …) live in their own vendor.
const FILAMENT_LIBRARY = "OrcaFilamentLibrary";

// Each vendor has an index, <profiles>/<Vendor>.json, listing its presets as
// { name, sub_path } per kind (machine_list/process_list/filament_list) —
// files are nested in subfolders and named unlike their `name`, so the index
// is the reliable lookup (it's what Orca itself loads).
function vendors(profilesDir) {
  return readdirSync(profilesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .filter((v) => existsSync(join(profilesDir, v)));
}

// Base presets (fdm_process_common, …) exist per vendor with different
// content, so inheritance resolves within the vendor the preset came from.
function vendorIndex(profilesDir, vendor, kind) {
  let entries = [];
  try {
    const index = JSON.parse(readFileSync(join(profilesDir, `${vendor}.json`), "utf8"));
    entries = index[`${kind}_list`] ?? [];
  } catch {
    return () => undefined;
  }
  const paths = new Map(entries.map((e) => [e.name, e.sub_path]));
  return (name) => {
    const subPath = paths.get(name);
    if (!subPath) return undefined;
    return JSON.parse(readFileSync(join(profilesDir, vendor, subPath), "utf8"));
  };
}

function findAndFlatten(profilesDir, kind, name, preferredVendors) {
  const order = [
    ...preferredVendors,
    ...vendors(profilesDir).filter((v) => !preferredVendors.includes(v)),
  ];
  for (const vendor of order) {
    const lookup = vendorIndex(profilesDir, vendor, kind);
    if (lookup(name)) return { vendor, preset: flattenPreset(name, lookup) };
  }
  throw new Error(`no ${kind} preset named "${name}" in ${profilesDir}`);
}

// Writes machine.json/process.json/filament.json into outDir and returns the
// flattened machine settings (for naming the printer in responses).
export function buildGenericPresets({ profilesDir, outDir, machine, process, filament }) {
  const m = findAndFlatten(profilesDir, "machine", machine, []);
  const p = findAndFlatten(profilesDir, "process", process, [m.vendor]);
  const f = findAndFlatten(profilesDir, "filament", filament, [m.vendor, FILAMENT_LIBRARY]);
  const presets = genericPresetSet({ machine: m.preset, process: p.preset, filament: f.preset });
  mkdirSync(outDir, { recursive: true });
  for (const [kind, preset] of Object.entries(presets)) {
    writeFileSync(join(outDir, `${kind}.json`), JSON.stringify(preset, null, 2));
  }
  return presets.machine;
}
