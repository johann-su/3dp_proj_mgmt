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
    [/\bh2s\b/i, { x: 340, y: 320 }], // Bambu H2S
    [/\b(?:x1|p1|p2s|a1|x2d)/i, { x: 256, y: 256 }], // Bambu X1(C/E)/P1(P/S)/P2S/A1/X2D
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
