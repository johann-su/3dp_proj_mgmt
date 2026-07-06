// Maps a model's `sourceUrl` (the makerworld/printables/onshape URL it was
// imported from) to the platform it came from, so the UI can badge the cover
// with that platform's logo. Detection is purely by hostname.

export type SourcePlatform = "makerworld" | "printables" | "onshape";

export const platformLabels: Record<SourcePlatform, string> = {
  makerworld: "MakerWorld",
  printables: "Printables",
  onshape: "Onshape",
};

export function platformFromSourceUrl(
  sourceUrl: string | null | undefined,
): SourcePlatform | null {
  if (!sourceUrl) return null;
  let host: string;
  try {
    host = new URL(sourceUrl).hostname;
  } catch {
    return null;
  }
  if (/(^|\.)makerworld\.com$/.test(host)) return "makerworld";
  if (/(^|\.)printables\.com$/.test(host)) return "printables";
  if (/(^|\.)onshape\.com$/.test(host)) return "onshape";
  return null;
}
