import type { PrinterInfo } from "@/db/schema";

export type FilamentSlot = { type: string; color?: string };

export type FilamentSummary = {
  // One entry per filament slot the print uses, in slot order.
  slots: FilamentSlot[];
  // "material" when the used slots differ in material, "color" when it's the
  // same material loaded more than once, null for a single-slot print. Worth
  // telling apart: one needs a second material on hand, the other only a swap.
  multi: "color" | "material" | null;
};

// Zips a file's stored per-slot filament arrays into something renderable, and
// answers "is this a multi-colour print?" — which the type list alone cannot,
// since two-colour PLA is ["PLA", "PLA"]. Returns null when the file records no
// filaments (a .step upload, or a row written before this was parsed; such rows
// also have no colours and were deduped, so they can under-report `multi`).
export function filamentSummary(
  info: PrinterInfo | null | undefined,
): FilamentSummary | null {
  const types = info?.filamentTypes;
  if (!types || types.length === 0) return null;
  const colors = info?.filamentColors;
  const slots = types.map((type, i) => ({ type, color: colors?.[i] }));
  const multi =
    slots.length < 2
      ? null
      : new Set(types.map((t) => t.toLowerCase())).size > 1
        ? ("material" as const)
        : ("color" as const);
  return { slots, multi };
}
