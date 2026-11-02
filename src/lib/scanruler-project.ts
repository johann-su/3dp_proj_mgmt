// What a `.scanruler` project holds, for the file row. A project is the
// session ScanRuler (src/lib/scanruler.ts) saves: a plain ZIP of the input
// files plus `project.json`. Stored on a model, it keeps the editable
// measurements / reverse-engineering features next to the parts they produced,
// and reopens in ScanRuler from the catalog.
//
// Our own reader of the file format — no ScanRuler code (AGPL) is used. The
// manifest is an internal format of that app (`schemaVersion` 1 today), so
// everything is read defensively: a field that's missing or the wrong shape is
// simply left out, and anything that isn't a ScanRuler manifest yields null.

import { readZipTextEntry, type RangeReader } from "@/lib/threemf-slice-info";

export const SCANRULER_MANIFEST = "project.json";

export type ScanRulerProjectSummary = {
  // The name given in ScanRuler, when there is one.
  name: string | null;
  appVersion: string | null;
  // The workspace it was saved in ("measure", "reverse", …).
  workspace: string | null;
  // The scan the project was made from, as it was named when opened.
  scanFile: string | null;
  // Fitted elements (spheres, planes, …) and dimensions in 3D Measure.
  elements: number;
  dimensions: number;
  // Reverse-engineer features (sketches, extrudes, fillets, …).
  features: number;
};

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function count(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function summarizeScanRulerManifest(raw: unknown): ScanRulerProjectSummary | null {
  const manifest = record(raw);
  if (!manifest || manifest.app !== "ScanRuler" || typeof manifest.schemaVersion !== "number") {
    return null;
  }
  const scan = record(manifest.scan);
  const reverse = record(manifest.reverse);
  return {
    name: str(manifest.name),
    appVersion: str(manifest.appVersion),
    workspace: str(manifest.workspace),
    scanFile: str(scan?.fileName),
    elements: count(scan?.elements),
    dimensions: count(scan?.dimensions),
    features: count(reverse?.features),
  };
}

// Reads only project.json out of the archive (ranged reads — the scan inside
// can be hundreds of MB). Null for anything that isn't a ScanRuler project.
export async function readScanRulerProjectSummary(
  readRange: RangeReader,
  size: number,
): Promise<ScanRulerProjectSummary | null> {
  const text = await readZipTextEntry(readRange, size, SCANRULER_MANIFEST);
  if (!text) return null;
  try {
    return summarizeScanRulerManifest(JSON.parse(text));
  } catch {
    return null;
  }
}

// One line for the file row: "bracket.stl · 4 elements · 2 dimensions".
// Empty for an unreadable project — the row still says what the file is.
export function describeScanRulerProject(summary: ScanRulerProjectSummary | null): string {
  if (!summary) return "";
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return [
    summary.scanFile,
    summary.elements > 0 && plural(summary.elements, "element"),
    summary.dimensions > 0 && plural(summary.dimensions, "dimension"),
    summary.features > 0 && plural(summary.features, "feature"),
  ]
    .filter(Boolean)
    .join(" · ");
}
