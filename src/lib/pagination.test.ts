import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  mergePage,
  toPage,
} from "@/lib/pagination";

// A row with just the keyset fields; the homepage feed merges models and
// collections that share this (createdAt, id) key.
function row(iso: string, id: string) {
  return { id, createdAt: new Date(iso) };
}

test("cursor round-trips the sort key (createdAt + id)", () => {
  const cursor = { createdAt: new Date("2026-07-07T12:34:56.789Z"), id: "abc-123" };
  const decoded = decodeCursor(encodeCursor(cursor));
  assert.ok(decoded);
  assert.equal(decoded.createdAt.toISOString(), cursor.createdAt.toISOString());
  assert.equal(decoded.id, cursor.id);
});

test("cursor survives an id containing the separator character", () => {
  // ids are UUIDs today, but the codec must not corrupt an id that happens to
  // contain "|" — splitting on the first separator keeps the rest intact.
  const cursor = { createdAt: new Date("2026-01-01T00:00:00.000Z"), id: "a|b|c" };
  assert.equal(decodeCursor(encodeCursor(cursor))?.id, "a|b|c");
});

test("garbage cursors decode to null so a bad cursor falls back to page one", () => {
  // Rather than throwing on tampered input, decoding fails soft to null.
  assert.equal(decodeCursor("not-a-cursor"), null);
  assert.equal(decodeCursor(""), null);
  assert.equal(
    decodeCursor(Buffer.from("no-separator", "utf8").toString("base64url")),
    null,
  );
  assert.equal(
    decodeCursor(Buffer.from("not-a-date|id", "utf8").toString("base64url")),
    null,
  );
});

test("toPage keeps PAGE_SIZE items and emits a cursor when a row was over-fetched", () => {
  // Callers query PAGE_SIZE + 1; the extra row signals "more pages exist".
  const rows = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => ({
    id: `id-${i}`,
    createdAt: new Date(2026, 0, 1, 0, 0, i),
  }));
  const page = toPage(rows);
  assert.equal(page.items.length, PAGE_SIZE);
  assert.ok(page.nextCursor);
  // The cursor points at the last returned row, not the over-fetched one.
  assert.equal(decodeCursor(page.nextCursor!)?.id, `id-${PAGE_SIZE - 1}`);
});

test("toPage returns a null cursor on the final (short) page", () => {
  const rows = [{ id: "only", createdAt: new Date() }];
  const page = toPage(rows);
  assert.equal(page.items.length, 1);
  assert.equal(page.nextCursor, null);
});

test("mergePage interleaves two keyset-ordered sources by (createdAt desc, id desc)", () => {
  // The homepage feed weaves models and collections back into one recency order.
  const models = [row("2026-01-05", "m1"), row("2026-01-03", "m2")];
  const collections = [row("2026-01-04", "c1"), row("2026-01-02", "c2")];

  const { items, nextCursor } = mergePage([models, collections]);

  assert.deepEqual(
    items.map((i) => i.id),
    ["m1", "c1", "m2", "c2"],
  );
  // Everything fit on one page → no further cursor.
  assert.equal(nextCursor, null);
});

test("mergePage breaks createdAt ties by id descending, across sources", () => {
  // Same timestamp in both sources — id is the tiebreaker so rows are neither
  // dropped nor duplicated at a page boundary.
  const a = [row("2026-01-01", "b")];
  const b = [row("2026-01-01", "a"), row("2026-01-01", "c")];

  const { items } = mergePage([a, b]);

  assert.deepEqual(
    items.map((i) => i.id),
    ["c", "b", "a"],
  );
});

test("mergePage caps at PAGE_SIZE and derives the next cursor from the last kept row", () => {
  // Over-fetch beyond a page so more rows remain; the cursor must point at the
  // PAGE_SIZE-th newest row so the following page resumes exactly after it.
  const source = Array.from({ length: PAGE_SIZE + 5 }, (_, i) =>
    // Descending timestamps: i=0 is newest.
    row(new Date(Date.UTC(2026, 0, 1) - i * 1000).toISOString(), `id-${i}`),
  );

  const { items, nextCursor } = mergePage([source]);

  assert.equal(items.length, PAGE_SIZE);
  const last = items[PAGE_SIZE - 1];
  const decoded = decodeCursor(nextCursor!);
  assert.equal(decoded?.id, last.id);
  assert.equal(decoded?.createdAt.getTime(), last.createdAt.getTime());
});

test("mergePage tolerates an empty source (category filter → models only)", () => {
  const models = [row("2026-01-02", "m1"), row("2026-01-01", "m2")];

  const { items, nextCursor } = mergePage([models, []]);

  assert.deepEqual(
    items.map((i) => i.id),
    ["m1", "m2"],
  );
  assert.equal(nextCursor, null);
});
