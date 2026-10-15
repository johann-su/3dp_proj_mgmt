import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filamentChangesFromPlates,
  filamentSummary,
  sliceFailureMessage,
} from "@/lib/printer-info";

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

// MakerWorld's "AMS" tag semantics: a filament change *within one print*.
// Several plates each printing a different filament need no AMS.
test("filamentChangesFromPlates only counts changes within a plate", () => {
  assert.equal(filamentChangesFromPlates([["PLA"], ["PETG"], ["PLA"]]), "none");
  assert.equal(filamentChangesFromPlates([["PLA"], ["PLA", "PLA", "PLA"]]), "color");
  assert.equal(filamentChangesFromPlates([["PLA", "pla"], ["PLA", "PETG"]]), "material");
  // Nothing sliced, or plates that don't list filaments: unknown, not "none".
  assert.equal(filamentChangesFromPlates([]), null);
  assert.equal(filamentChangesFromPlates([[], []]), null);
  assert.equal(filamentChangesFromPlates(undefined), null);
});

test("filamentSummary trusts the sliced result over the slot list", () => {
  // Two colours on two plates: slots say multi, but no plate changes filament.
  assert.equal(
    filamentSummary({ filamentTypes: ["PLA", "PETG"], filamentChanges: "none" })?.multi,
    null,
  );
  assert.equal(
    filamentSummary({ filamentTypes: ["PLA", "PLA"], filamentChanges: "color" })?.multi,
    "color",
  );
});

test("sliceFailureMessage names the printer a model doesn't fit", () => {
  assert.equal(
    sliceFailureMessage("plate 1: doesn't fit on the Bambu Lab P1S (256 × 256 × 250 mm)"),
    "Doesn't fit on the Bambu Lab P1S (256 × 256 × 250 mm)",
  );
  assert.equal(
    sliceFailureMessage("plate 3: doesn't fit on the Prusa MK4S (250 × 210 × 220 mm)"),
    "Plate 3 doesn't fit on the Prusa MK4S (250 × 210 × 220 mm)",
  );
  // Anything else stays the generic "may not be printable" warning.
  assert.match(sliceFailureMessage("Failed slicing the model."), /may not be printable/);
  assert.match(sliceFailureMessage(null), /may not be printable/);
});
