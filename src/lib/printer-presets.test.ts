import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BAMBU_PRINTER_MODELS,
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
