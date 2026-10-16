// Pure core of the infinite-scroll restore (see useInfiniteScroll): what a
// saved snapshot looks like, which ones are still usable, and which to evict.
// The browser glue — sessionStorage, history.state, scroll listeners — lives
// in the hook.
//
// Why snapshots at all: the homepage feed appends pages client-side, so the
// server-rendered page Next shows on Back holds only the first page. The
// browser's own scroll restoration can't reach a position on page three of a
// list that is now one page long, so the user lands near the top. Restoring
// the loaded pages *and* the offset puts them back where they left off.

export type ListSnapshot<T> = {
  items: T[];
  cursor: string | null;
  scrollY: number;
  savedAt: number;
};

// Older snapshots are ignored: the list has likely moved on, and card image
// URLs carry file tokens that eventually expire (src/lib/file-token.ts).
export const SNAPSHOT_MAX_AGE_MS = 60 * 60 * 1000;

// Snapshots kept per tab. Each history entry that showed a list gets one, so
// this bounds sessionStorage use across a long browsing session.
export const MAX_SNAPSHOTS = 10;

export const SNAPSHOT_PREFIX = "list-restore:";

export function snapshotKey(listKey: string, entryId: string): string {
  return `${SNAPSHOT_PREFIX}${listKey}:${entryId}`;
}

// Parses a stored snapshot, returning null for anything unusable: missing,
// corrupt, the wrong shape (an older format), or too old to trust.
export function parseSnapshot<T>(
  raw: string | null,
  nowMs: number,
  maxAgeMs = SNAPSHOT_MAX_AGE_MS,
): ListSnapshot<T> | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const s = value as Record<string, unknown>;
  if (
    !Array.isArray(s.items) ||
    !(s.cursor === null || typeof s.cursor === "string") ||
    typeof s.scrollY !== "number" ||
    !Number.isFinite(s.scrollY) ||
    typeof s.savedAt !== "number"
  ) {
    return null;
  }
  if (nowMs - s.savedAt > maxAgeMs || s.savedAt > nowMs) return null;
  return {
    items: s.items as T[],
    cursor: s.cursor,
    scrollY: Math.max(0, s.scrollY),
    savedAt: s.savedAt,
  };
}

// Given every stored snapshot's key and save time, returns the keys to delete
// so that only the `keep` most recent remain.
export function snapshotsToEvict(
  entries: { key: string; savedAt: number }[],
  keep = MAX_SNAPSHOTS,
): string[] {
  return [...entries]
    .sort((a, b) => b.savedAt - a.savedAt)
    .slice(keep)
    .map((e) => e.key);
}
