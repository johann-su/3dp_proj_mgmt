import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BED_PRESETS,
  BED_PRESET_GROUPS,
  bedForChoice,
  bedSizeForModel,
  defaultBedChoice,
  resolveBedSizeMm,
} from "@/lib/printer-beds";

test("bedSizeForModel matches the P1S/X1 model strings the cards store", () => {
  // The stored PrinterInfo.model is the raw slicer label, e.g. "Bambu Lab P1S".
  assert.deepEqual(bedSizeForModel("Bambu Lab P1S"), { x: 256, y: 256 });
  assert.deepEqual(bedSizeForModel("Bambu Lab X1 Carbon"), { x: 256, y: 256 });
  // The A1 mini's narrower rule must win over the broader A1 → 256 rule.
  assert.deepEqual(bedSizeForModel("Bambu Lab A1 mini"), { x: 180, y: 180 });
  // Prusa MK-series is rectangular, not square.
  assert.deepEqual(bedSizeForModel("MK4S"), { x: 250, y: 210 });
});

test("bedSizeForModel returns undefined for unknown or missing models", () => {
  assert.equal(bedSizeForModel("Some Random Printer"), undefined);
  assert.equal(bedSizeForModel(undefined), undefined);
});

// The precise parsed bed always wins; the lookup only backfills older rows
// whose printerInfo predates bed parsing (has a model but no bedSizeMm).
test("resolveBedSizeMm prefers the parsed bed, else falls back to the model", () => {
  assert.deepEqual(
    resolveBedSizeMm({ model: "Bambu Lab P1S", bedSizeMm: { x: 250, y: 250 } }),
    { x: 250, y: 250 },
  );
  assert.deepEqual(resolveBedSizeMm({ model: "Bambu Lab P1S" }), {
    x: 256,
    y: 256,
  });
  assert.equal(resolveBedSizeMm({ model: "Unknown" }), null);
  assert.equal(resolveBedSizeMm(null), null);
});

// The picker maps its dropdown value to a bed. The two sentinels and a real
// preset are the paths the viewer actually takes each render.
test("bedForChoice resolves the file, auto, and preset values", () => {
  const fileBed = { x: 256, y: 256 };
  // "file" is the per-file default: the bed parsed from the .3mf's own config.
  assert.deepEqual(bedForChoice("file", fileBed), fileBed);
  // "auto" means no real bed → footprint square (viewer draws its own size).
  assert.equal(bedForChoice("auto", fileBed), null);
  // A preset id resolves to that plate regardless of the file's own bed.
  assert.deepEqual(bedForChoice("prusa-mk", fileBed), { x: 250, y: 210 });
});

// A value left over after the preset list changed must not blank the plate —
// it falls back to the file's own bed rather than returning nothing.
test("bedForChoice falls back to the file bed for an unknown preset id", () => {
  assert.deepEqual(bedForChoice("no-such-printer", { x: 180, y: 180 }), {
    x: 180,
    y: 180,
  });
  // With no file bed either, an unknown id degrades to the footprint square.
  assert.equal(bedForChoice("no-such-printer", null), null);
});

// The picker opens on the file's own bed when we have one, else on "auto".
test("defaultBedChoice picks the file bed when present, else auto", () => {
  assert.equal(defaultBedChoice({ x: 256, y: 256 }), "file");
  assert.equal(defaultBedChoice(null), "auto");
});

// The <optgroup> source must cover every preset exactly once and keep each
// brand's first-seen order, so the dropdown lists nothing twice or out of place.
test("BED_PRESET_GROUPS partitions BED_PRESETS by brand, order preserved", () => {
  const flattened = BED_PRESET_GROUPS.flatMap(([, presets]) => presets);
  assert.deepEqual(flattened, BED_PRESETS);

  const groupNames = BED_PRESET_GROUPS.map(([group]) => group);
  assert.deepEqual(new Set(groupNames).size, groupNames.length); // no repeats

  const ids = BED_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "preset ids must be unique");
});
