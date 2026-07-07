import { and, eq, lt, or, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

// How many items a listing returns per page (homepage models, collections).
export const PAGE_SIZE = 24;

// A page of items plus the opaque cursor to fetch the next one (null = end).
export type Page<T> = { items: T[]; nextCursor: string | null };

// The sort key of the last row on a page. Listings are ordered by
// (createdAt desc, id desc); `id` breaks ties so rows sharing a createdAt are
// neither skipped nor duplicated across page boundaries.
export type Cursor = { createdAt: Date; id: string };

// Cursors are opaque to the client — encode/decode keep the wire format an
// implementation detail. `|` never appears in a UUID or an ISO timestamp, so
// it is a safe separator.
export function encodeCursor(cursor: Cursor): string {
  const raw = `${cursor.createdAt.toISOString()}|${cursor.id}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

// Returns null for anything that isn't a cursor we produced (tampered or
// truncated input) so a bad cursor degrades to "first page", never a throw.
export function decodeCursor(raw: string): Cursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const sep = decoded.indexOf("|");
  if (sep === -1) return null;
  const createdAt = new Date(decoded.slice(0, sep));
  const id = decoded.slice(sep + 1);
  if (!id || Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id };
}

// Keyset predicate for "everything strictly after this cursor" under a
// (createdAt desc, id desc) ordering. Using the sort key instead of OFFSET
// keeps pages stable as rows are inserted while the user scrolls.
export function keysetWhere(
  createdAt: PgColumn,
  id: PgColumn,
  cursor: Cursor,
): SQL {
  return or(
    lt(createdAt, cursor.createdAt),
    and(eq(createdAt, cursor.createdAt), lt(id, cursor.id)),
  )!;
}

// Slices one over-fetched row (PAGE_SIZE + 1) off a result set to decide
// whether more pages exist, and derives the next cursor from the last kept row.
export function toPage<T extends { id: string; createdAt: Date }>(
  rows: T[],
): Page<T> {
  const hasMore = rows.length > PAGE_SIZE;
  const items = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null;
  return { items, nextCursor };
}
