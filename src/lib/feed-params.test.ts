import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeFeedCursor,
  encodeFeedCursor,
  feedSortIsModelOnly,
  parseFeedSort,
} from "@/lib/feed-params";

// Unknown or missing values must degrade to "newest" rather than reach the
// SQL builder — a crafted/stale ?sort= shouldn't error the page.
test("parseFeedSort defaults to newest and rejects unknown values", () => {
  assert.equal(parseFeedSort(undefined), "newest");
  assert.equal(parseFeedSort("sideways"), "newest");
  assert.equal(parseFeedSort("views"), "views");
  assert.equal(parseFeedSort(["downloads", "views"]), "downloads");
});

// Collections have no download_count equivalent to sum, so that sort is
// models-only; every other sort ranks both tables together.
test("feedSortIsModelOnly is true only for downloads", () => {
  assert.equal(feedSortIsModelOnly("downloads"), true);
  assert.equal(feedSortIsModelOnly("newest"), false);
  assert.equal(feedSortIsModelOnly("oldest"), false);
  assert.equal(feedSortIsModelOnly("updated"), false);
  assert.equal(feedSortIsModelOnly("views"), false);
});

// The cursor is self-describing: it carries its own kind so decode never needs
// to know which sort produced it.
test("feed cursor round-trips both keyset shapes", () => {
  const time = { kind: "time", at: "2026-01-02T03:04:05.000Z", id: "abc" } as const;
  assert.deepEqual(decodeFeedCursor(encodeFeedCursor(time)), time);

  const metric = { kind: "metric", value: 42, id: "def" } as const;
  assert.deepEqual(decodeFeedCursor(encodeFeedCursor(metric)), metric);
});

// ids are UUIDs today, but the codec must not corrupt an id that happens to
// contain "|" — splitting on the first two separators keeps the rest intact.
test("feed cursor survives an id containing the separator character", () => {
  const cursor = { kind: "metric", value: 7, id: "a|b|c" } as const;
  assert.equal(decodeFeedCursor(encodeFeedCursor(cursor))?.id, "a|b|c");
});

// A tampered or malformed cursor degrades to "first page" (null), never a throw.
test("decodeFeedCursor rejects malformed input", () => {
  assert.equal(decodeFeedCursor("not-base64-!@#$"), null);
  assert.equal(decodeFeedCursor(Buffer.from("time|only-two").toString("base64url")), null);
  assert.equal(
    decodeFeedCursor(Buffer.from("metric|notanumber|id").toString("base64url")),
    null,
  );
  assert.equal(
    decodeFeedCursor(Buffer.from("bogus|x|id").toString("base64url")),
    null,
  );
});
