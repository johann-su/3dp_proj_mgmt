import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BAMBU_PRINTER_MODELS,
  derivativeFilename,
  shortPrinterLabel,
} from "@/lib/printer-presets";
import { bedSizeForModel } from "@/lib/printer-beds";

test("every printer preset resolves a bed size via the shared lookup", () => {
  // The presets deliberately carry no bed sizes of their own — the dialog and
  // the override endpoint both resolve them through KNOWN_BED_SIZES. A preset
  // this lookup doesn't know would silently produce an override without a bed.
  for (const model of BAMBU_PRINTER_MODELS) {
    assert.ok(bedSizeForModel(model), `no bed size for preset "${model}"`);
  }
});

test("shortPrinterLabel strips only the redundant Bambu vendor prefix", () => {
  assert.equal(shortPrinterLabel("Bambu Lab X1 Carbon"), "X1 Carbon");
  assert.equal(shortPrinterLabel("Bambu Lab A1 mini"), "A1 mini");
  // Non-Bambu models (Prusa's are short already) pass through unchanged.
  assert.equal(shortPrinterLabel("MK4S"), "MK4S");
  assert.equal(shortPrinterLabel("Prusa CORE One"), "Prusa CORE One");
});

test("derivativeFilename appends printer slug and nozzle to the source name", () => {
  // The naming contract from the issue: <base>_<printer>_<nozzle>.3mf.
  assert.equal(
    derivativeFilename("fuselage.3mf", "Bambu Lab P1S", 0.4),
    "fuselage_p1s_04.3mf",
  );
  assert.equal(
    derivativeFilename("fuselage.3mf", "Bambu Lab A1 mini", 0.2),
    "fuselage_a1_mini_02.3mf",
  );
  // Custom printer names slugify; a missing nozzle just drops its suffix.
  assert.equal(
    derivativeFilename("Box v2.3mf", "Prusa CORE One"),
    "Box v2_prusa_core_one.3mf",
  );
});
