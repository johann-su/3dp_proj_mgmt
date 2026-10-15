import type { FilamentChanges, PrinterInfo } from "@/db/schema";

export type FilamentSlot = { type: string; color?: string };

export type FilamentSummary = {
  // One entry per filament slot the print uses, in slot order.
  slots: FilamentSlot[];
  // Whether a plate changes filament mid-print: "material" when it mixes
  // materials, "color" when it's the same material in several colours, null
  // when no plate does. Worth telling apart: one needs a second material on
  // hand, the other only a swap.
  multi: "color" | "material" | null;
};

// "Does printing a plate mean changing filament mid-print?" from the filament
// types each sliced plate prints from (slice_info.config). One plate is one
// print, so a project whose plates each use a different filament needs no
// AMS — only a plate listing several does. Null when nothing was sliced, or
// when no plate lists its filaments (older slicers omit them): unknown, not
// "none".
export function filamentChangesFromPlates(
  plateFilaments: string[][] | null | undefined,
): FilamentChanges | null {
  if (!plateFilaments?.some((types) => types.length > 0)) return null;
  const changing = plateFilaments.filter((types) => types.length > 1);
  if (changing.length === 0) return "none";
  return changing.some((types) => new Set(types.map((t) => t.toLowerCase())).size > 1)
    ? "material"
    : "color";
}

// Zips a file's stored per-slot filament arrays into something renderable, and
// answers "does this need filament changes mid-print?". That comes from the
// sliced per-plate result (`filamentChanges`); rows sliced before it was
// recorded fall back to guessing from the used slots — which over-reports a
// project whose plates each print one different filament. Returns null when
// the file records no filaments (a .step upload, or a row written before this
// was parsed; such rows also have no colours and were deduped, so they can
// under-report `multi`).
export function filamentSummary(
  info: PrinterInfo | null | undefined,
): FilamentSummary | null {
  const types = info?.filamentTypes;
  if (!types || types.length === 0) return null;
  const colors = info?.filamentColors;
  const slots = types.map((type, i) => ({ type, color: colors?.[i] }));
  const multi =
    info?.filamentChanges !== undefined
      ? info.filamentChanges === "none"
        ? null
        : info.filamentChanges
      : slots.length < 2
        ? null
        : new Set(types.map((t) => t.toLowerCase())).size > 1
          ? ("material" as const)
          : ("color" as const);
  return { slots, multi };
}

// What to tell the user about a file the slicer service couldn't slice. A
// model too big for the printer it was sliced for is a fact about that
// printer, not a broken file, so it gets its own message naming the printer
// ("plate 2: doesn't fit on the Bambu Lab P1S (256 × 256 × 250 mm)").
export function sliceFailureMessage(error: string | null | undefined): string {
  const fit = error?.match(/^(?:plate (\d+): )?doesn't fit on the (.+)$/);
  if (fit) {
    return fit[1] && fit[1] !== "1"
      ? `Plate ${fit[1]} doesn't fit on the ${fit[2]}`
      : `Doesn't fit on the ${fit[2]}`;
  }
  return "Couldn't be sliced — the file may not be printable";
}
