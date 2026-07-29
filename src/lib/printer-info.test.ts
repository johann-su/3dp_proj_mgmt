import { test } from "node:test";
import assert from "node:assert/strict";
import { filamentSummary } from "@/lib/printer-info";

// The whole point of storing filaments per slot: the same material in two slots
// is a colour change (an AMS/MMU swap), two different materials mean the
// printer needs both loaded. Neither is a plain single-filament print.
test("filamentSummary tells multi-colour and multi-material apart", () => {
  assert.equal(filamentSummary({ filamentTypes: ["PLA", "PLA"] })?.multi, "color");
  assert.equal(
    filamentSummary({ filamentTypes: ["PLA", "PETG"] })?.multi,
    "material",
  );
  // Slicers aren't consistent about case; "PLA" and "pla" are one material.
  assert.equal(filamentSummary({ filamentTypes: ["PLA", "pla"] })?.multi, "color");
  assert.equal(filamentSummary({ filamentTypes: ["PLA"] })?.multi, null);
});

test("filamentSummary zips colours onto their slots", () => {
  assert.deepEqual(
    filamentSummary({
      filamentTypes: ["PLA", "PLA"],
      filamentColors: ["#ff0000", "#000000"],
    })?.slots,
    [
      { type: "PLA", color: "#ff0000" },
      { type: "PLA", color: "#000000" },
    ],
  );
});

// Files sliced before colours were parsed (and non-print files) still render:
// the slots come back uncoloured rather than the summary vanishing.
test("filamentSummary handles files without colour or filament data", () => {
  assert.deepEqual(filamentSummary({ filamentTypes: ["PETG"] })?.slots, [
    { type: "PETG", color: undefined },
  ]);
  assert.equal(filamentSummary({ model: "Bambu Lab P1S" }), null);
  assert.equal(filamentSummary(null), null);
});
