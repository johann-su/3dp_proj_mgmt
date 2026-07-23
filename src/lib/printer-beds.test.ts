import { test } from "node:test";
import assert from "node:assert/strict";
import { bedSizeForModel, resolveBedSizeMm } from "@/lib/printer-beds";

test("bedSizeForModel matches the P1S/X1 model strings the cards store", () => {
  // The stored PrinterInfo.model is the raw slicer label, e.g. "Bambu Lab P1S".
  assert.deepEqual(bedSizeForModel("Bambu Lab P1S"), { x: 256, y: 256 });
  assert.deepEqual(bedSizeForModel("Bambu Lab X1 Carbon"), { x: 256, y: 256 });
  // The A1 mini's narrower rule must win over the broader A1 → 256 rule.
  assert.deepEqual(bedSizeForModel("Bambu Lab A1 mini"), { x: 180, y: 180 });
  // The H2 family is rectangular, and H2S differs from H2D.
  assert.deepEqual(bedSizeForModel("Bambu Lab H2D"), { x: 350, y: 320 });
  assert.deepEqual(bedSizeForModel("Bambu Lab H2S"), { x: 340, y: 320 });
  assert.deepEqual(bedSizeForModel("Bambu Lab P2S"), { x: 256, y: 256 });
  assert.deepEqual(bedSizeForModel("Bambu Lab X2D"), { x: 256, y: 256 });
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
