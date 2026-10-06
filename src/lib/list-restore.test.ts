import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSnapshot,
  snapshotKey,
  snapshotsToEvict,
  SNAPSHOT_MAX_AGE_MS,
} from "@/lib/list-restore";

const NOW = 1_800_000_000_000;
const snap = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ items: [{ id: 1 }], cursor: "c2", scrollY: 1200, savedAt: NOW - 1000, ...over });

test("parseSnapshot round-trips a fresh snapshot", () => {
  assert.deepEqual(parseSnapshot(snap(), NOW), {
    items: [{ id: 1 }],
    cursor: "c2",
    scrollY: 1200,
    savedAt: NOW - 1000,
  });
});

test("parseSnapshot accepts a null cursor — the list was fully loaded", () => {
  assert.equal(parseSnapshot(snap({ cursor: null }), NOW)?.cursor, null);
});

test("parseSnapshot rejects snapshots older than the max age", () => {
  // Stale lists and expiring file tokens: past the window, start fresh.
  assert.equal(parseSnapshot(snap({ savedAt: NOW - SNAPSHOT_MAX_AGE_MS - 1 }), NOW), null);
});

test("parseSnapshot rejects a save time in the future", () => {
  // A clock change shouldn't make a snapshot immortal.
  assert.equal(parseSnapshot(snap({ savedAt: NOW + 60_000 }), NOW), null);
});

test("parseSnapshot treats missing, corrupt or mis-shaped storage as nothing saved", () => {
  // sessionStorage is user-editable and may hold an older format.
  assert.equal(parseSnapshot(null, NOW), null);
  assert.equal(parseSnapshot("{not json", NOW), null);
  assert.equal(parseSnapshot("[]", NOW), null);
  assert.equal(parseSnapshot(snap({ items: "nope" }), NOW), null);
  assert.equal(parseSnapshot(snap({ cursor: 5 }), NOW), null);
  assert.equal(parseSnapshot(snap({ scrollY: null }), NOW), null);
});

test("snapshotKey separates lists and history entries", () => {
  // Two queries on the same history entry, or one query on two entries,
  // must never restore each other's items.
  assert.notEqual(snapshotKey("feed:a", "e1"), snapshotKey("feed:b", "e1"));
  assert.notEqual(snapshotKey("feed:a", "e1"), snapshotKey("feed:a", "e2"));
});

test("snapshotsToEvict keeps only the most recent snapshots", () => {
  const entries = [
    { key: "old", savedAt: 1 },
    { key: "newest", savedAt: 3 },
    { key: "mid", savedAt: 2 },
  ];
  assert.deepEqual(snapshotsToEvict(entries, 2), ["old"]);
  assert.deepEqual(snapshotsToEvict(entries, 5), []);
});
