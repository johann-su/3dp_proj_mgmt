import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  toPage,
} from "@/lib/pagination";

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
