import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeSearchCursor,
  effectiveSort,
  encodeSearchCursor,
  hasModelOnlyFilter,
  parseSearchParams,
  searchFiltersToParams,
  searchFiltersToQueryString,
  type SearchFilters,
} from "@/lib/search-params";

// Sort defaults to relevance only when there is a query to rank against;
// browsing with no term should fall back to a stable recency order.
test("parseSearchParams defaults sort to relevance with a query, newest without", () => {
  assert.equal(parseSearchParams({ q: "gear" }).sort, "relevance");
  assert.equal(parseSearchParams({}).sort, "newest");
});

// Unknown enum values must not leak into the query — they degrade to defaults
// rather than reaching the SQL builder.
test("parseSearchParams rejects unknown type/sort values", () => {
  const f = parseSearchParams({ type: "bogus", sort: "sideways" });
  assert.equal(f.type, "all");
  assert.equal(f.sort, "newest");
});

// A repeated ?filament= param arrives as an array; a single one as a string.
// Both must normalize to a list so the OR-within-filament filter works.
test("parseSearchParams normalizes single and repeated filament params to a list", () => {
  assert.deepEqual(parseSearchParams({ filament: "PLA" }).filaments, ["PLA"]);
  assert.deepEqual(parseSearchParams({ filament: ["PLA", "PETG"] }).filaments, [
    "PLA",
    "PETG",
  ]);
});

// Numeric filters only apply when they actually parse — junk is dropped so a
// crafted URL can't inject a NaN comparison.
test("parseSearchParams keeps numeric filters only when finite", () => {
  assert.equal(parseSearchParams({ nozzle: "0.4" }).nozzle, 0.4);
  assert.equal(parseSearchParams({ nozzle: "wide" }).nozzle, undefined);
  assert.equal(parseSearchParams({ printTime: "3600" }).maxPrintTime, 3600);
  assert.equal(parseSearchParams({ printTime: "soon" }).maxPrintTime, undefined);
});

// Relevance is meaningless without a query, so it collapses to newest — the
// query builder relies on this to pick the right keyset shape.
test("effectiveSort collapses relevance to newest when there is no query", () => {
  assert.equal(effectiveSort(parseSearchParams({ sort: "relevance" })), "newest");
  assert.equal(
    effectiveSort(parseSearchParams({ sort: "relevance", q: "x" })),
    "relevance",
  );
  assert.equal(effectiveSort(parseSearchParams({ sort: "oldest" })), "oldest");
});

// "downloads" totals model_files.download_count, which collections have no
// equivalent of — a collections-only search falls back to newest rather than
// silently returning nothing.
test("effectiveSort collapses downloads to newest for a collections-only search", () => {
  assert.equal(
    effectiveSort(parseSearchParams({ sort: "downloads", type: "collections" })),
    "newest",
  );
  assert.equal(
    effectiveSort(parseSearchParams({ sort: "downloads", type: "models" })),
    "downloads",
  );
  assert.equal(
    effectiveSort(parseSearchParams({ sort: "views", type: "collections" })),
    "views",
  );
});

// Collections carry no printer metadata, so any of these filters means the
// results are model-only — the flag drives that exclusion.
test("hasModelOnlyFilter reflects the printer/filament/nozzle/print-time filters", () => {
  assert.equal(hasModelOnlyFilter(parseSearchParams({ user: "u1" })), false);
  assert.equal(hasModelOnlyFilter(parseSearchParams({ printer: "P1S" })), true);
  assert.equal(hasModelOnlyFilter(parseSearchParams({ filament: "PLA" })), true);
  assert.equal(hasModelOnlyFilter(parseSearchParams({ nozzle: "0.4" })), true);
  assert.equal(hasModelOnlyFilter(parseSearchParams({ printTime: "3600" })), true);
});

// Serialization omits defaults so shared URLs stay clean, but round-trips every
// active filter back to an equivalent object.
test("searchFiltersToParams omits defaults", () => {
  assert.deepEqual(searchFiltersToParams(parseSearchParams({})), {});
  const params = searchFiltersToParams(parseSearchParams({ q: "gear", sort: "relevance" }));
  assert.equal(params.q, "gear");
  assert.equal(params.sort, undefined); // relevance is the default → omitted
});

test("filters survive a serialize → parse round-trip", () => {
  const original: SearchFilters = {
    q: "planet gear",
    type: "models",
    userId: "user-123",
    printer: "Bambu Lab P1S",
    filaments: ["PLA", "PETG"],
    nozzle: 0.4,
    maxPrintTime: 10800,
    sort: "oldest",
  };
  const restored = parseSearchParams(searchFiltersToParams(original));
  assert.deepEqual(restored, original);
});

test("searchFiltersToQueryString repeats array params", () => {
  const qs = searchFiltersToQueryString(
    parseSearchParams({ filament: ["PLA", "PETG"] }),
  );
  const parsed = new URLSearchParams(qs);
  assert.deepEqual(parsed.getAll("filament"), ["PLA", "PETG"]);
});

// The cursor is self-describing: it carries its own kind so decode never needs
// to know which sort produced it.
test("search cursor round-trips all three keyset shapes", () => {
  const score = { kind: "score", score: 0.42, id: "abc" } as const;
  assert.deepEqual(decodeSearchCursor(encodeSearchCursor(score)), score);

  const time = { kind: "time", createdAt: "2026-01-02T03:04:05.000Z", id: "def" } as const;
  assert.deepEqual(decodeSearchCursor(encodeSearchCursor(time)), time);

  const metric = { kind: "metric", value: 42, id: "ghi" } as const;
  assert.deepEqual(decodeSearchCursor(encodeSearchCursor(metric)), metric);
});

// A tampered or malformed cursor degrades to "first page" (null), never a throw.
test("decodeSearchCursor rejects malformed input", () => {
  assert.equal(decodeSearchCursor("not-base64-!@#$"), null);
  assert.equal(decodeSearchCursor(Buffer.from("time|only-two").toString("base64url")), null);
  assert.equal(
    decodeSearchCursor(Buffer.from("score|notanumber|id").toString("base64url")),
    null,
  );
  assert.equal(
    decodeSearchCursor(Buffer.from("bogus|x|id").toString("base64url")),
    null,
  );
});
