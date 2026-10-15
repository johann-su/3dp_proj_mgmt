// Image-build step: flattens OrcaSlicer's bundled system presets into the
// generic machine/process/filament profile used for files that carry no
// slicer settings (see flattenPreset/genericPresetSet in lib.mjs).
//
//   node build-presets.mjs <vendor profile dir> <out dir> <machine> <process> <filament>

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { flattenPreset, genericPresetSet } from "./lib.mjs";

const [vendorDir, outDir, machineName, processName, filamentName] =
  process.argv.slice(2);
if (!filamentName) {
  console.error(
    "usage: build-presets.mjs <vendor dir> <out dir> <machine> <process> <filament>",
  );
  process.exit(2);
}

// Presets are looked up by their `name`, which doesn't always match the file
// name, so index every preset of a kind once.
function indexKind(kind) {
  const byName = new Map();
  for (const file of readdirSync(join(vendorDir, kind))) {
    if (!file.endsWith(".json")) continue;
    const preset = JSON.parse(readFileSync(join(vendorDir, kind, file), "utf8"));
    if (preset.name) byName.set(preset.name, preset);
  }
  return (name) => byName.get(name);
}

const presets = genericPresetSet({
  machine: flattenPreset(machineName, indexKind("machine")),
  process: flattenPreset(processName, indexKind("process")),
  filament: flattenPreset(filamentName, indexKind("filament")),
});

mkdirSync(outDir, { recursive: true });
for (const [kind, preset] of Object.entries(presets)) {
  writeFileSync(join(outDir, `${kind}.json`), JSON.stringify(preset, null, 2));
  console.log(`${kind}: ${preset.name} (${Object.keys(preset).length} keys)`);
}
