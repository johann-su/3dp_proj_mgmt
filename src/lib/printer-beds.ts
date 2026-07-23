import type { PrinterInfo } from "@/db/schema";

// Known nominal build-plate sizes (mm) for common printers, matched loosely by
// substring against a PrinterInfo.model string. Used in two places:
//   - as a last resort when a file's embedded config carries no usable bed
//     shape (see bedSizeFromPoints in threemf-slice-info.ts), and
//   - at read time (resolveBedSizeMm) so models processed before bed parsing
//     existed — their stored printerInfo has a model but no bedSizeMm — still
//     get a real plate without re-slicing.
// Order matters: the narrower rule comes first (the A1 mini must beat the
// broader A1 rule).
const KNOWN_BED_SIZES: ReadonlyArray<readonly [RegExp, { x: number; y: number }]> =
  [
    [/a1\s*mini/i, { x: 180, y: 180 }],
    [/\bh2d\b/i, { x: 350, y: 320 }], // Bambu H2D
    [/\b(?:x1|p1|a1)/i, { x: 256, y: 256 }], // Bambu X1(C/E)/P1(P/S)/A1 family
    [/\bmk[234]s?\b/i, { x: 250, y: 210 }], // Prusa MK2/MK3/MK4 (incl. S)
    [/\b(?:core\s*one|coreone)\b/i, { x: 250, y: 220 }], // Prusa CORE One
    [/prusa[^a-z]*mini|\bmini\b/i, { x: 180, y: 180 }], // Prusa Mini
    [/prusa[^a-z]*xl|\bxl\b/i, { x: 360, y: 360 }], // Prusa XL
  ];

export function bedSizeForModel(
  model: string | undefined,
): { x: number; y: number } | undefined {
  if (!model) return undefined;
  for (const [re, size] of KNOWN_BED_SIZES) {
    if (re.test(model)) return size;
  }
  return undefined;
}

// The bed the 3D preview should draw for a file: the exact size parsed from its
// embedded config when present, else a known-model lookup so files sliced
// before bed parsing existed still get a real plate. Null when neither yields a
// size — the viewer then falls back to a footprint-sized square (issue #80).
export function resolveBedSizeMm(
  info: PrinterInfo | null | undefined,
): { x: number; y: number } | null {
  return info?.bedSizeMm ?? bedSizeForModel(info?.model) ?? null;
}

// Common build plates offered in the 3D preview's plate-size dropdown, so a
// model can be checked against a bed other than the one it was sliced for
// (issue #80 follow-up). `x`/`y` are the nominal printable area (mm); `group`
// drives the <optgroup>s. Members of a family that share a plate are listed
// together on one entry. This is a convenience picker, not an exhaustive
// registry — the per-file default still comes from the embedded config or
// bedSizeForModel above.
export type BedPreset = {
  id: string;
  group: string;
  label: string;
  x: number;
  y: number;
};

export const BED_PRESETS: readonly BedPreset[] = [
  // Bambu Lab
  { id: "bambu-a1-mini", group: "Bambu Lab", label: "A1 mini", x: 180, y: 180 },
  { id: "bambu-a1", group: "Bambu Lab", label: "A1", x: 256, y: 256 },
  { id: "bambu-p1", group: "Bambu Lab", label: "P1P / P1S", x: 256, y: 256 },
  { id: "bambu-x1", group: "Bambu Lab", label: "X1 / X1C / X1E", x: 256, y: 256 },
  { id: "bambu-x2", group: "Bambu Lab", label: "X2D", x: 256, y: 256 },
  { id: "bambu-h2d", group: "Bambu Lab", label: "H2D", x: 350, y: 320 },
  // Prusa
  { id: "prusa-mini", group: "Prusa", label: "Mini / Mini+", x: 180, y: 180 },
  { id: "prusa-mk", group: "Prusa", label: "MK3S / MK4 / MK4S", x: 250, y: 210 },
  { id: "prusa-core-one", group: "Prusa", label: "CORE One", x: 250, y: 220 },
  { id: "prusa-xl", group: "Prusa", label: "XL", x: 360, y: 360 },
  // Creality
  { id: "creality-ender", group: "Creality", label: "Ender 3 / 5", x: 220, y: 220 },
  { id: "creality-k1", group: "Creality", label: "K1 / K1C", x: 220, y: 220 },
  { id: "creality-k1-max", group: "Creality", label: "K1 Max", x: 300, y: 300 },
  { id: "creality-cr10", group: "Creality", label: "CR-10", x: 300, y: 300 },
  // Voron
  { id: "voron-250", group: "Voron", label: "2.4 / Trident 250", x: 250, y: 250 },
  { id: "voron-300", group: "Voron", label: "2.4 / Trident 300", x: 300, y: 300 },
  { id: "voron-350", group: "Voron", label: "2.4 / Trident 350", x: 350, y: 350 },
];

// BED_PRESETS grouped by brand, preserving the array's order, for rendering the
// dropdown's <optgroup>s without regrouping on every render.
export const BED_PRESET_GROUPS: ReadonlyArray<
  readonly [string, readonly BedPreset[]]
> = (() => {
  const groups = new Map<string, BedPreset[]>();
  for (const preset of BED_PRESETS) {
    const existing = groups.get(preset.group);
    if (existing) existing.push(preset);
    else groups.set(preset.group, [preset]);
  }
  return [...groups.entries()];
})();

// The plate-size dropdown's value is a preset id or one of two sentinels:
// "file" (the bed from the .3mf's own config — the per-file default) and "auto"
// (no real bed; the viewer draws a square sized to the geometry's footprint).
export const BED_CHOICE_FILE = "file";
export const BED_CHOICE_AUTO = "auto";

// Default the picker to the file's own bed when the config gave us one, else to
// the footprint-sized square.
export function defaultBedChoice(fileBed: { x: number; y: number } | null) {
  return fileBed ? BED_CHOICE_FILE : BED_CHOICE_AUTO;
}

// Resolve a dropdown value to the bed the viewer should draw. Null means "no
// real bed" → the footprint-square fallback. An unknown/missing preset (e.g. a
// value left over after the preset list changed) falls back to the file's own
// bed so a stale choice can't blank the plate.
export function bedForChoice(
  choice: string,
  fileBed: { x: number; y: number } | null,
): { x: number; y: number } | null {
  if (choice === BED_CHOICE_AUTO) return null;
  if (choice === BED_CHOICE_FILE) return fileBed;
  const preset = BED_PRESETS.find((p) => p.id === choice);
  return preset ? { x: preset.x, y: preset.y } : fileBed;
}
