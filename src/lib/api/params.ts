// Query-string parsing and keyset cursors for the API's list endpoints
// (GET /api/v1/models, /collections). Pure, so the rules are unit-tested; the
// SQL that consumes them lives in src/lib/api/queries.ts.
//
// Listings are keyset-paginated on (sort timestamp, id): a stable total
// order, so paging never skips or repeats a row while models are added. The
// cursor records which sort it belongs to, and one from another sort is
// rejected rather than silently misread. The timestamp travels as Postgres'
// own text form (microseconds): a JS Date would round it to milliseconds, and
// rows created within the same millisecond as a page boundary would then be
// skipped.

import { isSourcePlatform, type SourcePlatform } from "@/lib/sources/registry";

export const MODEL_SORTS = [
  "created_desc",
  "created_asc",
  "updated_desc",
  "updated_asc",
] as const;
export type ModelSort = (typeof MODEL_SORTS)[number];

export const DEFAULT_LIMIT = 24;
export const MAX_LIMIT = 100;

export type Cursor = { sort: string; at: string; id: string };

export type ModelListQuery = {
  q?: string;
  categoryId?: string;
  tags: string[];
  source?: SourcePlatform | "manual";
  // A user id, or "me" for the key's owner (resolved by the route).
  owner?: string;
  collectionId?: string;
  updatedSince?: Date;
  sort: ModelSort;
  limit: number;
  cursor: Cursor | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

// "2026-11-02 14:22:44.116789" — `timestamp::text`, no zone.
const PG_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/;

export function encodeCursor(sort: string, at: string, id: string): string {
  return Buffer.from(JSON.stringify({ s: sort, a: at, i: id })).toString("base64url");
}

export function decodeCursor(raw: string, sort: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      parsed?.s !== sort ||
      typeof parsed.a !== "string" ||
      !PG_TIMESTAMP_RE.test(parsed.a) ||
      typeof parsed.i !== "string" ||
      !isUuid(parsed.i)
    ) {
      return null;
    }
    return { sort, at: parsed.a, id: parsed.i };
  } catch {
    return null;
  }
}

export function parseLimit(raw: string | null): number | { error: string } {
  if (raw === null || raw === "") return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    return { error: `limit must be an integer from 1 to ${MAX_LIMIT}` };
  }
  return n;
}

export function parseModelListQuery(
  sp: URLSearchParams,
): ModelListQuery | { error: string } {
  const sortRaw = sp.get("sort") ?? "created_desc";
  if (!(MODEL_SORTS as readonly string[]).includes(sortRaw)) {
    return { error: `sort must be one of ${MODEL_SORTS.join(", ")}` };
  }
  const sort = sortRaw as ModelSort;

  const limit = parseLimit(sp.get("limit"));
  if (typeof limit !== "number") return limit;

  const rawCursor = sp.get("cursor");
  const cursor = rawCursor ? decodeCursor(rawCursor, sort) : null;
  if (rawCursor && !cursor) {
    return { error: "cursor is invalid or belongs to a different sort" };
  }

  const q = sp.get("q")?.trim() || undefined;
  if (q && q.length > 200) return { error: "q is too long" };

  const categoryId = sp.get("category") ?? undefined;
  if (categoryId && !isUuid(categoryId)) return { error: "category must be a category id" };

  const collectionId = sp.get("collection") ?? undefined;
  if (collectionId && !isUuid(collectionId)) {
    return { error: "collection must be a collection id" };
  }

  // Repeatable (?tag=a&tag=b), matching models with any of them — the same
  // "any" the app's saved searches use.
  const tags = sp
    .getAll("tag")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (tags.length > 20) return { error: "At most 20 tag filters" };

  const sourceRaw = sp.get("source") ?? undefined;
  if (sourceRaw && sourceRaw !== "manual" && !isSourcePlatform(sourceRaw)) {
    return { error: "source must be a source platform or manual" };
  }
  const source = sourceRaw as SourcePlatform | "manual" | undefined;

  const owner = sp.get("owner")?.trim() || undefined;
  if (owner && owner.length > 64) return { error: "owner must be a user id or me" };

  const updatedSinceRaw = sp.get("updatedSince");
  let updatedSince: Date | undefined;
  if (updatedSinceRaw) {
    const ms = Date.parse(updatedSinceRaw);
    if (Number.isNaN(ms)) return { error: "updatedSince must be an ISO 8601 timestamp" };
    updatedSince = new Date(ms);
  }

  return {
    q,
    categoryId,
    tags,
    source,
    owner,
    collectionId,
    updatedSince,
    sort,
    limit,
    cursor,
  };
}
