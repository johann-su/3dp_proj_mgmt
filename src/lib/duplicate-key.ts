// Identity of an upstream design, derived from a model's `sourceUrl` — the
// comparison key duplicate detection uses instead of the stored string.
//
// Two `sourceUrl` values can name the same design without being byte-equal:
// MakerWorld carries a `#`-hash selecting a print profile, Onshape carries a
// workspace/version pin plus the tab that was imported, and both survive
// `validateSourceUrl`'s canonicalization (it only strips tracking params).
// Each platform's own parser already extracts the stable id, so reuse those
// rather than re-deriving the URL shapes here.

import { parseMakerworldUrl } from "@/lib/import/makerworld";
import { parsePrintablesUrl } from "@/lib/import/printables";
import { parseOnshapeUrl } from "@/lib/onshape/api";
import type { SourcePlatform } from "@/lib/platform";

export type SourceKey = { platform: SourcePlatform; id: string };

// Which signal flagged a duplicate. Recorded on dismissed matches
// (model_duplicates.detected_via) so an admin reviewing them later knows
// whether the models share an upstream design or an identical file. Lives here
// rather than next to the table so @/db/schema doesn't have to import a module
// that reads from the database.
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
  const makerworldId = parseMakerworldUrl(url);
  if (makerworldId) return { platform: "makerworld", id: makerworldId };
  const printablesId = parsePrintablesUrl(url);
  if (printablesId) return { platform: "printables", id: printablesId };
  const onshapePin = parseOnshapeUrl(url);
  // The document id alone is the identity: a version-pinned (/v/) import, a
  // different branch and another tab of the same document are all the same
  // upstream design, so wvm/wvmId/elementId are deliberately ignored.
  if (onshapePin) return { platform: "onshape", id: onshapePin.documentId };
  return null;
}

export function sameSourceKey(a: SourceKey | null, b: SourceKey | null): boolean {
  return !!a && !!b && a.platform === b.platform && a.id === b.id;
}

// A content hash as stageStream/stageBuffer produce them. Checked because the
// value travels back through the client (like `size`), and a malformed one
// would otherwise reach the LIKE-free but still pointless `IN` lookup.
export function isContentHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

// Substring every `sourceUrl` naming this design must contain — a cheap SQL
// prefilter (`source_url LIKE '%fragment%'`) that narrows the scan before the
// authoritative comparison, which always re-parses each candidate with
// sourceKeyFromUrl. It over-matches on purpose ("/models/12" also matches
// model 123), so it must never be used as the match on its own. Ids are
// digits or lowercase hex, so there is nothing for LIKE to escape.
export function sourceKeyUrlFragment(key: SourceKey): string {
  switch (key.platform) {
    case "makerworld":
      return `/models/${key.id}`;
    case "printables":
      return `/model/${key.id}`;
    case "onshape":
      return `/documents/${key.id}`;
  }
}
