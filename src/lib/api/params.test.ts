import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeCursor,
  DEFAULT_LIMIT,
  encodeCursor,
  parseModelListQuery,
  type ModelListQuery,
} from "@/lib/api/params";

const parse = (qs: string) => parseModelListQuery(new URLSearchParams(qs));
const ok = (qs: string) => {
  const result = parse(qs);
  assert.ok(!("error" in result), `expected ${qs} to parse`);
  return result as ModelListQuery;
};
const ID = "0b5e7d3a-8d0e-4b9e-9a51-2f6f0c1d2e3f";

test("an empty query is the newest-first first page", () => {
  const q = ok("");
  assert.equal(q.sort, "created_desc");
  assert.equal(q.limit, DEFAULT_LIMIT);
  assert.equal(q.cursor, null);
  assert.deepEqual(q.tags, []);
});

// Cursors carry Postgres' microsecond text form: a JS Date would round to
// milliseconds and skip rows created within the same millisecond as a page
// boundary.
test("a cursor round-trips with microsecond precision", () => {
  const raw = encodeCursor("updated_asc", "2026-11-02 14:22:44.116789", ID);
  assert.deepEqual(decodeCursor(raw, "updated_asc"), {
    sort: "updated_asc",
    at: "2026-11-02 14:22:44.116789",
    id: ID,
  });
});

// Reading one sort's cursor as another's would page through the wrong order.
test("a cursor from another sort, or a forged one, is rejected", () => {
  const raw = encodeCursor("created_desc", "2026-11-02 14:22:44.116789", ID);
  assert.ok("error" in (parse(`sort=updated_desc&cursor=${raw}`) as object));
  const forged = Buffer.from(JSON.stringify({ s: "created_desc", a: "now()", i: ID })).toString(
    "base64url",
  );
  assert.equal(decodeCursor(forged, "created_desc"), null);
});

test("limit, sort and ids are validated", () => {
  assert.ok("error" in (parse("limit=0") as object));
  assert.ok("error" in (parse("limit=101") as object));
  assert.ok("error" in (parse("limit=2.5") as object));
  assert.ok("error" in (parse("sort=random") as object));
  assert.ok("error" in (parse("category=7") as object));
  assert.ok("error" in (parse("collection=../x") as object));
});

// Tag filters match like the app's saved searches: any of them, lowercase.
test("repeated tags are collected and normalized", () => {
  assert.deepEqual(ok("tag=PETG&tag=%20bracket%20&tag=").tags, ["petg", "bracket"]);
});

test("source accepts registered platforms and manual only", () => {
  assert.equal(ok("source=onshape").source, "onshape");
  assert.equal(ok("source=manual").source, "manual");
  assert.ok("error" in (parse("source=thingiverse") as object));
});

test("updatedSince must be a timestamp", () => {
  assert.equal(
    ok("updatedSince=2026-11-01T00:00:00Z").updatedSince?.toISOString(),
    "2026-11-01T00:00:00.000Z",
  );
  assert.ok("error" in (parse("updatedSince=yesterday") as object));
});
