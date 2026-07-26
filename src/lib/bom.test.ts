import { test } from "node:test";
import assert from "node:assert/strict";
import { bomToCsv, groupBySection, parseBomCsv, sanitizeBomItems } from "@/lib/bom";

test("parseBomCsv maps header aliases onto the BOM columns", () => {
  const result = parseBomCsv(
    "Item,Qty,URL,Picture\nM3x8 screw,4,https://example.com/screw,https://example.com/screw.jpg",
  );
  assert.deepEqual(result, {
    items: [
      {
        name: "M3x8 screw",
        quantity: "4",
        link: "https://example.com/screw",
        imageUrl: "https://example.com/screw.jpg",
        section: null,
      },
    ],
  });
});

test("parseBomCsv without a header reads columns as name,quantity,link,image", () => {
  const result = parseBomCsv("Bearing 608ZZ,2\nPTFE tube,1");
  assert.ok("items" in result);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].name, "Bearing 608ZZ");
  assert.equal(result.items[0].quantity, "2");
  assert.equal(result.items[0].link, null);
});

test("parseBomCsv handles quoting, a UTF-8 BOM, blank rows and missing quantities", () => {
  const csv =
    '﻿name,quantity\n"Screw, M3x8 ""long""",4\n\n,\nWidget,';
  const result = parseBomCsv(csv);
  assert.deepEqual(
    "items" in result && result.items.map((i) => [i.name, i.quantity]),
    [
      ['Screw, M3x8 "long"', "4"],
      ["Widget", "1"], // empty quantity defaults to 1, blank rows are dropped
    ],
  );
});

test("parseBomCsv reports an error for empty or item-less files", () => {
  assert.ok("error" in parseBomCsv(""));
  assert.ok("error" in parseBomCsv("name,quantity\n"));
});

test("sanitizeBomItems rejects non-http(s) links and images", () => {
  const item = {
    name: "Nut",
    quantity: "1",
    link: null,
    imageUrl: null,
    section: null,
  };
  assert.ok("error" in sanitizeBomItems([{ ...item, link: "javascript:alert(1)" }]));
  assert.ok("error" in sanitizeBomItems([{ ...item, imageUrl: "ftp://x/y.png" }]));
  assert.ok("items" in sanitizeBomItems([{ ...item, link: "https://example.com" }]));
});

test("sanitizeBomItems caps the number of items", () => {
  const items = Array.from({ length: 201 }, (_, i) => ({
    name: `Part ${i}`,
    quantity: "1",
    link: null,
    imageUrl: null,
    section: null,
  }));
  assert.ok("error" in sanitizeBomItems(items));
});

test("bomToCsv output survives a round-trip through parseBomCsv", () => {
  const items = [
    {
      name: 'Bracket, angled "V2"',
      quantity: "2",
      link: "https://example.com/bracket",
      imageUrl: null,
    },
    { name: "Multi\nline note", quantity: "1", link: null, imageUrl: null },
  ];
  const parsed = parseBomCsv(bomToCsv(items));
  assert.ok("items" in parsed);
  assert.deepEqual(
    parsed.items.map(({ name, quantity, link, imageUrl }) => ({ name, quantity, link, imageUrl })),
    items,
  );
});

// Sections are an ordering convention, not a stored tree: ungrouped items come
// first, then each section in the order it first appears, and an item joins the
// section it names even if that run was interrupted. The model page and the MCP
// tool both present the BOM this way.
test("groupBySection puts ungrouped items first and keeps first-appearance order", () => {
  const grouped = groupBySection([
    { name: "Filament", section: null },
    { name: "M3x8 screw", section: "Screws" },
    { name: "Heat set insert", section: "Screws" },
    { name: "ESC", section: "Electronics" },
    { name: "M3 nut", section: "Screws" },
  ]);
  assert.deepEqual(
    grouped.map((g) => [g.section, g.items.map((i) => i.name)]),
    [
      [null, ["Filament"]],
      ["Screws", ["M3x8 screw", "Heat set insert", "M3 nut"]],
      ["Electronics", ["ESC"]],
    ],
  );
});

test("groupBySection omits the ungrouped bucket when every item has a section", () => {
  const grouped = groupBySection([{ name: "ESC", section: "Electronics" }]);
  assert.deepEqual(grouped, [{ section: "Electronics", items: [{ name: "ESC", section: "Electronics" }] }]);
});
