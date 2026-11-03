// Identity of an upstream design, derived from a model's `sourceUrl` — the comparison key duplicate detection uses instead of the stored string.
//
// Two `sourceUrl` values can name the same design without being byte-equal: MakerWorld carries a `#`-hash selecting a print profile, Onshape carries a workspace/version pin plus the tab that was imported, and both survive `canonicalSourceUrl`'s canonicalization (it only strips tracking params). Each source's descriptor (src/lib/sources/registry.ts) already extracts the stable design id, so reuse that rather than re-deriving the URL shapes here.

import { SOURCES, sourceById, type SourcePlatform } from "@/lib/sources/registry";

export type SourceKey = { platform: SourcePlatform; id: string };

// Which signal flagged a duplicate. Recorded on dismissed matches (model_duplicates.detected_via) so an admin reviewing them later knows whether the models share an upstream design or an identical file. Lives here rather than next to the table so @/db/schema doesn't have to import a module that reads from the database.
export type DuplicateVia = "source_url" | "file_hash";

export function sourceKeyFromUrl(
  raw: string | URL | null | undefined,
): SourceKey | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = raw instanceof URL ? raw : new URL(raw);
  } catch {
    return null;
  }
  for (const source of SOURCES) {
    const id = source.designId(url);
    if (id) return { platform: source.id, id };
  }
  return null;
}

export function sameSourceKey(a: SourceKey | null, b: SourceKey | null): boolean {
  return !!a && !!b && a.platform === b.platform && a.id === b.id;
}

// A content hash as stageStream/stageBuffer produce them. Checked because the value travels back through the client (like `size`), and a malformed one would otherwise reach the LIKE-free but still pointless `IN` lookup.
export function isContentHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

// Substring every `sourceUrl` naming this design must contain — a cheap SQL prefilter (`source_url LIKE '%fragment%'`) that narrows the scan before the authoritative comparison, which always re-parses each candidate with sourceKeyFromUrl. It over-matches on purpose ("/models/12" also matches model 123), so it must never be used as the match on its own. Ids are digits or lowercase hex, so there is nothing for LIKE to escape.
export function sourceKeyUrlFragment(key: SourceKey): string {
  return sourceById(key.platform).designUrlFragment(key.id);
}
