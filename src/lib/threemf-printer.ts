// Writes a user-chosen printer profile (issue #79) back into a .3mf archive's
// embedded slicer config, so downloads, "open in slicer" deep links and the
// estimate slicer all see the chosen printer — not just the DB record. Which
// entry gets patched mirrors how the configs are read (threemf-slice-info.ts
// and the slicer service's deriveConfig): Bambu/Orca JSON first, then the
// PrusaSlicer ini; an archive with neither gets a minimal Bambu-style
// project_settings.config so at least the nozzle reaches the estimate slicer.
//
// Follows the unzipSync → mutate an entry → zipSync pattern established by
// threemf-normalize.ts (fflate only, no load-time side effects, so it stays
// unit-testable).

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

export type PrinterOverride = {
  model: string;
  nozzleDiameterMm?: number;
  bedSizeMm?: { x: number; y: number };
};

const PROJECT_SETTINGS_PATH = "Metadata/project_settings.config";
const PRUSA_CONFIG_PATH = "Metadata/Slic3r_PE.config";

// Both slicers describe the bed as a polygon of "XxY" mm points; we write a
// rectangle with the origin at 0/0 like the stock profiles do.
function bedCorners({ x, y }: { x: number; y: number }): string[] {
  return ["0x0", `${x}x0`, `${x}x${y}`, `0x${y}`];
}

// "Bambu Lab P1S" + 0.4 → "Bambu Lab P1S 0.4 nozzle", matching Bambu's system
// preset naming so the desktop slicer selects the right machine profile when
// the file is opened as a project. printerInfoFromBambu/-PrusaIni also fall
// back to this key when printer_model is missing.
function settingsId(override: PrinterOverride): string | undefined {
  return override.nozzleDiameterMm !== undefined
    ? `${override.model} ${override.nozzleDiameterMm} nozzle`
    : undefined;
}

// Patches a Bambu/Orca project_settings.config JSON string. Only the printer
// identity keys change; process/filament settings stay untouched so estimates
// and prints keep the profile the file was actually set up with. Returns null
// when the entry isn't the JSON we expect (leave unknown content alone).
export function patchBambuSettings(
  json: string,
  override: PrinterOverride,
): string | null {
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(json);
  } catch {
    return null;
  }
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    return null;
  }

  settings.printer_model = override.model;
  const id = settingsId(override);
  if (id !== undefined) settings.printer_settings_id = id;
  if (override.nozzleDiameterMm !== undefined) {
    // nozzle_diameter is per-extruder; keep the extruder count (the H2D has
    // two) and set every slot — a physical hotend swap changes all of them.
    const slots = Array.isArray(settings.nozzle_diameter)
      ? Math.max(1, settings.nozzle_diameter.length)
      : 1;
    settings.nozzle_diameter = new Array(slots).fill(
      String(override.nozzleDiameterMm),
    );
  }
  if (override.bedSizeMm) {
    settings.printable_area = bedCorners(override.bedSizeMm);
  }
  return JSON.stringify(settings, null, 4);
}

// Patches a PrusaSlicer Slic3r_PE.config ini: replaces the printer identity
// lines in place, appending any that are missing.
export function patchPrusaIni(ini: string, override: PrinterOverride): string {
  const replacements = new Map<string, string>();
  replacements.set("printer_model", override.model);
  if (override.nozzleDiameterMm !== undefined) {
    replacements.set("nozzle_diameter", String(override.nozzleDiameterMm));
  }
  if (override.bedSizeMm) {
    replacements.set("bed_shape", bedCorners(override.bedSizeMm).join(","));
  }

  const lines = ini.split("\n");
  const seen = new Set<string>();
  const out = lines.map((line) => {
    const m = line.match(/^\s*([a-z_0-9]+)\s*=\s*(.*)$/);
    if (!m || !replacements.has(m[1])) return line;
    seen.add(m[1]);
    let value = replacements.get(m[1])!;
    if (m[1] === "nozzle_diameter") {
      // Comma-separated per extruder — keep the extruder count.
      value = new Array(m[2].split(",").length).fill(value).join(",");
    }
    return `${m[1]} = ${value}`;
  });
  for (const [key, value] of replacements) {
    if (!seen.has(key)) out.push(`${key} = ${value}`);
  }
  return out.join("\n");
}

// A Bambu-style config for archives that embed no slicer settings at all
// (plain core-spec 3mf, Onshape exports). Just the printer identity — the
// slicer service's whitelist translation picks up nozzle_diameter, and
// readSliceData yields the same PrinterInfo the DB stores.
function minimalBambuSettings(override: PrinterOverride): string {
  const settings: Record<string, unknown> = { printer_model: override.model };
  const id = settingsId(override);
  if (id !== undefined) settings.printer_settings_id = id;
  if (override.nozzleDiameterMm !== undefined) {
    settings.nozzle_diameter = [String(override.nozzleDiameterMm)];
  }
  if (override.bedSizeMm) {
    settings.printable_area = bedCorners(override.bedSizeMm);
  }
  return JSON.stringify(settings, null, 4);
}

// Returns a copy of the archive with the override applied, or null when the
// archive couldn't be patched (not a ZIP, or its project settings entry holds
// something we don't understand). A null result means "store the override in
// the DB only" — never an error the caller should surface.
export function applyPrinterOverride(
  data: Uint8Array,
  override: PrinterOverride,
): Uint8Array | null {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data);
  } catch {
    return null;
  }

  // Real slicer exports use the canonical entry casing, but the ZIP spec
  // doesn't require it — match like the reader (threemf-slice-info.ts) does,
  // and keep the found entry's own name when replacing it.
  const entryNamed = (path: string) =>
    Object.keys(entries).find((name) => name.toLowerCase() === path.toLowerCase());

  const bambuPath = entryNamed(PROJECT_SETTINGS_PATH);
  if (bambuPath) {
    const patched = patchBambuSettings(strFromU8(entries[bambuPath]), override);
    if (patched === null) return null;
    entries[bambuPath] = strToU8(patched);
    return zipSync(entries);
  }

  const prusaPath = entryNamed(PRUSA_CONFIG_PATH);
  if (prusaPath) {
    entries[prusaPath] = strToU8(
      patchPrusaIni(strFromU8(entries[prusaPath]), override),
    );
    return zipSync(entries);
  }

  // No config at all — create one. Canonical casing: the slicer service reads
  // this exact path with `unzip -p`, which matches case-sensitively.
  entries[PROJECT_SETTINGS_PATH] = strToU8(minimalBambuSettings(override));
  return zipSync(entries);
}
