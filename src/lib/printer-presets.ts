// Bambu printer presets for the per-file "edit printer info" dialog (issue
// #79). Deliberately file-scoped: there is no account-level "printers I own"
// registry — a preset only describes what one particular .3mf is meant for.
// Bed sizes are not duplicated here; every model below resolves through the
// shared KNOWN_BED_SIZES lookup (bedSizeForModel), so the model→bed mapping
// keeps a single home in printer-beds.ts (asserted in printer-presets.test.ts).

// Model names exactly as Bambu Studio writes `printer_model` into
// project_settings.config, so an override round-trips through the same
// parsing (printerInfoFromBambu) as a file Bambu sliced itself. Current
// lineup plus the discontinued-but-widely-owned machines (P1P, X1C, X1E);
// anything else goes through the dialog's "Custom" fields.
export const BAMBU_PRINTER_MODELS = [
  "Bambu Lab A1 mini",
  "Bambu Lab A1",
  "Bambu Lab P1P",
  "Bambu Lab P1S",
  "Bambu Lab P2S",
  "Bambu Lab X1 Carbon",
  "Bambu Lab X1E",
  "Bambu Lab H2S",
  "Bambu Lab H2D",
] as const;

// The hotend sizes Bambu sells; every machine ships with 0.4.
export const BAMBU_NOZZLE_SIZES_MM = [0.2, 0.4, 0.6, 0.8] as const;
export const DEFAULT_NOZZLE_MM = 0.4;

// Chip label for the model page's printer filter: stored printer_model
// strings are verbose ("Bambu Lab X1 Carbon"), and the vendor prefix carries
// no information in a row of chips. Prusa's printer_model values are already
// short (MK4S, MINI, XL), so only the Bambu prefix needs stripping.
export function shortPrinterLabel(model: string): string {
  return model.replace(/^bambu\s*lab\s+/i, "").trim() || model;
}
