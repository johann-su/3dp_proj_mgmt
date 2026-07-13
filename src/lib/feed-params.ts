// Pure parsing/serialization for the homepage feed's sort control — mirrors
// search-params.ts's split (pure logic here, the DB query in list-queries.ts)
// so this stays unit-testable without a DB import.

export type FeedSort = "newest" | "oldest" | "updated" | "views" | "downloads";

const SORTS: FeedSort[] = ["newest", "oldest", "updated", "views", "downloads"];

export function parseFeedSort(v: string | string[] | undefined): FeedSort {
  const s = Array.isArray(v) ? v[0] : v;
  return SORTS.includes(s as FeedSort) ? (s as FeedSort) : "newest";
}

// "downloads" totals model_files.download_count; collections have no
// equivalent column (there's nothing to sum), so that sort only ranks models
// — the caller drops collections from the feed entirely rather than order
// them arbitrarily within it.
export function feedSortIsModelOnly(sort: FeedSort): boolean {
  return sort === "downloads";
}

// Self-describing keyset cursor for the (models ∪ collections) feed. "time"
// covers both recency sorts — newest/oldest keyset on created_at, "updated" on
// updated_at — the query picks the column, the cursor just carries its value.
// "metric" covers the count-based sorts (views, downloads). `|` never appears
// in a UUID, ISO timestamp, or number, so it's a safe separator.
export type FeedCursor =
  | { kind: "time"; at: string; id: string }
  | { kind: "metric"; value: number; id: string };

export function encodeFeedCursor(cursor: FeedCursor): string {
  const raw =
    cursor.kind === "time"
      ? `time|${cursor.at}|${cursor.id}`
      : `metric|${cursor.value}|${cursor.id}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

// Returns null for anything we didn't produce (tampered/truncated) so a bad
// cursor degrades to "first page" rather than throwing. Splits on the first
// two separators only (not a 3-way split) so an id that happens to contain
// "|" survives intact.
export function decodeFeedCursor(raw: string): FeedCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const firstSep = decoded.indexOf("|");
  if (firstSep === -1) return null;
  const kind = decoded.slice(0, firstSep);
  const rest = decoded.slice(firstSep + 1);
  const secondSep = rest.indexOf("|");
  if (secondSep === -1) return null;
  const value = rest.slice(0, secondSep);
  const id = rest.slice(secondSep + 1);
  if (!id) return null;
  if (kind === "time") {
    if (Number.isNaN(new Date(value).getTime())) return null;
    return { kind: "time", at: value, id };
  }
  if (kind === "metric") {
    const metric = Number(value);
    if (!Number.isFinite(metric)) return null;
    return { kind: "metric", value: metric, id };
  }
  return null;
}
