// Maps a model's `sourceUrl` (the makerworld/printables/onshape URL it was
// imported from) to the platform it came from, so the UI can badge the cover
// with that platform's logo. Detection is purely by hostname; the hosts and
// labels live with the rest of each source's description in
// src/lib/sources/registry.ts.

import { sourceForUrl, sourceLabels, type SourcePlatform } from "@/lib/sources/registry";

export type { SourcePlatform };

export const platformLabels: Record<SourcePlatform, string> = sourceLabels;

export function platformFromSourceUrl(
  sourceUrl: string | null | undefined,
): SourcePlatform | null {
  return sourceForUrl(sourceUrl)?.id ?? null;
}
