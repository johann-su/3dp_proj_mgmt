// Pure parsing/serialization for the /search page — no DB or S3 imports, so it
// stays unit-testable (see search-params.test.ts). The DB query that consumes
// these filters lives in search.ts.

export type SearchType = "all" | "models" | "collections";
export type SearchSort = "relevance" | "newest" | "oldest";

// Fixed print-time buckets (in seconds) offered as a filter — the corpus is
// small and the exact per-file numbers are approximate (~), so buckets read
// better than a free-form slider. A model matches if any of its files prints
// within the chosen ceiling.
export const PRINT_TIME_BUCKETS: { label: string; maxSeconds: number }[] = [
  { label: "Under 1 h", maxSeconds: 3600 },
  { label: "Under 3 h", maxSeconds: 3 * 3600 },
  { label: "Under 6 h", maxSeconds: 6 * 3600 },
  { label: "Under 12 h", maxSeconds: 12 * 3600 },
];

export type SearchFilters = {
  q: string;
  type: SearchType;
  userId?: string;
  printer?: string;
  // Match a file whose filament list contains ANY of these (OR within filament).
  filaments: string[];
  nozzle?: number;
  maxPrintTime?: number; // seconds
  sort: SearchSort;
};

const TYPES: SearchType[] = ["all", "models", "collections"];
const SORTS: SearchSort[] = ["relevance", "newest", "oldest"];

// The implicit sort when the URL doesn't pin one: relevance ranks a query,
// recency orders a plain browse. Shared by parse and serialize so a round-trip
// through the URL is a no-op (and default URLs stay clean).
function defaultSort(q: string): SearchSort {
  return q ? "relevance" : "newest";
}

function one(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  const trimmed = s?.trim();
  return trimmed ? trimmed : undefined;
}

function many(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((s) => s.trim()).filter(Boolean);
}

// Whether any filter that only models can satisfy is active. When true,
// collections are excluded regardless of `type` (they carry no printer info).
export function hasModelOnlyFilter(f: SearchFilters): boolean {
  return (
    f.printer !== undefined ||
    f.filaments.length > 0 ||
    f.nozzle !== undefined ||
    f.maxPrintTime !== undefined
  );
}

// Relevance ordering is only meaningful with a query term; without one it
// degrades to "newest" so the results still have a stable, sensible order.
export function effectiveSort(f: SearchFilters): Exclude<SearchSort, "relevance"> | "relevance" {
  if (f.sort === "relevance" && f.q === "") return "newest";
  return f.sort;
}

export function parseSearchParams(
  sp: Record<string, string | string[] | undefined>,
): SearchFilters {
  const type = one(sp.type);
  const sort = one(sp.sort);
  const nozzle = one(sp.nozzle);
  const maxPrintTime = one(sp.printTime);
  const q = one(sp.q) ?? "";

  const nozzleNum = nozzle !== undefined ? Number(nozzle) : NaN;
  const maxPrintTimeNum = maxPrintTime !== undefined ? Number(maxPrintTime) : NaN;

  return {
    q,
    type: TYPES.includes(type as SearchType) ? (type as SearchType) : "all",
    userId: one(sp.user),
    printer: one(sp.printer),
    filaments: many(sp.filament),
    nozzle: Number.isFinite(nozzleNum) ? nozzleNum : undefined,
    maxPrintTime: Number.isFinite(maxPrintTimeNum) ? maxPrintTimeNum : undefined,
    sort: SORTS.includes(sort as SearchSort) ? (sort as SearchSort) : defaultSort(q),
  };
}

// Serializes filters back to a flat query object for building <Link> hrefs and
// passing to the load-more server action. Omits defaults to keep URLs clean.
export function searchFiltersToParams(f: SearchFilters): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (f.q) out.q = f.q;
  if (f.type !== "all") out.type = f.type;
  if (f.userId) out.user = f.userId;
  if (f.printer) out.printer = f.printer;
  if (f.filaments.length > 0) out.filament = f.filaments;
  if (f.nozzle !== undefined) out.nozzle = String(f.nozzle);
  if (f.maxPrintTime !== undefined) out.printTime = String(f.maxPrintTime);
  if (f.sort !== defaultSort(f.q)) out.sort = f.sort;
  return out;
}

export function searchFiltersToQueryString(f: SearchFilters): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(searchFiltersToParams(f))) {
    if (Array.isArray(v)) v.forEach((item) => params.append(k, item));
    else params.set(k, v);
  }
  return params.toString();
}

// --- Cursor -------------------------------------------------------------
//
// Keyset cursors for the combined (models ∪ collections) result stream. The
// cursor is self-describing — it carries its own `kind` tag so decoding never
// needs to know which sort produced it. Relevance keysets on the trigram score
// (score desc, id desc); the time sorts keyset on created_at. `|` never occurs
// in a UUID, ISO timestamp, or JSON number, so it's a safe separator.

export type SearchCursor =
  | { kind: "score"; score: number; id: string }
  | { kind: "time"; createdAt: string; id: string };

export function encodeSearchCursor(cursor: SearchCursor): string {
  const raw =
    cursor.kind === "score"
      ? `score|${cursor.score}|${cursor.id}`
      : `time|${cursor.createdAt}|${cursor.id}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

// Returns null for anything we didn't produce (tampered/truncated) so a bad
// cursor degrades to "first page" rather than throwing.
export function decodeSearchCursor(raw: string): SearchCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const parts = decoded.split("|");
  if (parts.length !== 3) return null;
  const [kind, value, id] = parts;
  if (!id) return null;
  if (kind === "score") {
    const score = Number(value);
    if (!Number.isFinite(score)) return null;
    return { kind: "score", score, id };
  }
  if (kind === "time") {
    if (Number.isNaN(new Date(value).getTime())) return null;
    return { kind: "time", createdAt: value, id };
  }
  return null;
}
