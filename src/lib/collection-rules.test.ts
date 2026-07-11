import { test } from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  MAX_RULE_CONDITIONS,
  parseRuleTree,
  ruleTreeToSql,
  type RuleGroup,
} from "@/lib/collection-rules";

// Renders a compiled fragment to text + bound params without a DB connection,
// so the tests can assert on the actual SQL shape.
function toQuery(tree: RuleGroup) {
  return new PgDialect().sqlToQuery(ruleTreeToSql(tree));
}

function parsed(input: unknown): RuleGroup {
  const result = parseRuleTree(input);
  assert.ok("tree" in result, `expected valid tree, got: ${JSON.stringify(result)}`);
  return result.tree;
}

// --- parseRuleTree ----------------------------------------------------------

test("accepts the nested AND/OR shape from the issue and normalizes tags", () => {
  const tree = parsed({
    op: "AND",
    rules: [
      { field: "tags", op: "any", value: [" Voron ", "voron", "MODS"] },
      { field: "printer", value: "Bambu Lab P1S", negate: true },
      {
        op: "OR",
        rules: [
          { field: "printTime", value: 3600 },
          { field: "parametric" },
        ],
      },
    ],
  });
  // Tags dedupe case-insensitively and lowercase (they're stored lowercased).
  assert.deepEqual(tree.rules[0], {
    field: "tags",
    op: "any",
    value: ["voron", "mods"],
    negate: false,
  });
});

test("rejects unknown fields — everything in the tree becomes SQL", () => {
  assert.ok("error" in parseRuleTree({ op: "AND", rules: [{ field: "evil", value: "x" }] }));
});

test("rejects empty groups, so a saved tree always constrains membership", () => {
  assert.ok("error" in parseRuleTree({ op: "AND", rules: [] }));
  assert.ok(
    "error" in parseRuleTree({ op: "AND", rules: [{ op: "OR", rules: [] }] }),
  );
});

test("rejects nesting beyond the depth cap", () => {
  const deep = {
    op: "AND",
    rules: [
      { op: "OR", rules: [{ op: "AND", rules: [{ op: "OR", rules: [{ field: "parametric" }] }] }] },
    ],
  };
  assert.ok("error" in parseRuleTree(deep));
});

test("rejects more conditions than the cap", () => {
  const many = {
    op: "OR",
    rules: Array.from({ length: MAX_RULE_CONDITIONS + 1 }, () => ({
      field: "parametric",
    })),
  };
  assert.ok("error" in parseRuleTree(many));
});

test("numeric fields require positive finite numbers, not numeric strings", () => {
  assert.ok("error" in parseRuleTree({ op: "AND", rules: [{ field: "nozzle", value: "0.4" }] }));
  assert.ok("error" in parseRuleTree({ op: "AND", rules: [{ field: "addedWithin", value: -7 }] }));
  assert.ok("error" in parseRuleTree({ op: "AND", rules: [{ field: "downloads", value: NaN }] }));
  assert.ok("tree" in parseRuleTree({ op: "AND", rules: [{ field: "nozzle", value: 0.4 }] }));
});

test("rejects bad group ops and non-object nodes", () => {
  assert.ok("error" in parseRuleTree({ op: "XOR", rules: [{ field: "parametric" }] }));
  assert.ok("error" in parseRuleTree({ op: "AND", rules: ["parametric"] }));
  assert.ok("error" in parseRuleTree(null));
});

// --- ruleTreeToSql ----------------------------------------------------------

test("user values are bound as parameters, never spliced into the SQL text", () => {
  const hostile = "'; DROP TABLE models; --";
  const q = toQuery(
    parsed({ op: "AND", rules: [{ field: "text", value: hostile }] }),
  );
  assert.ok(!q.sql.includes("DROP TABLE"));
  assert.ok(q.params.includes(hostile));
});

test("negate wraps the condition in NOT", () => {
  const q = toQuery(
    parsed({ op: "AND", rules: [{ field: "parametric", negate: true }] }),
  );
  assert.match(q.sql, /NOT \(EXISTS/);
});

test("AND/OR group ops join conditions accordingly", () => {
  const q = toQuery(
    parsed({
      op: "OR",
      rules: [{ field: "parametric" }, { field: "downloads", value: 5 }],
    }),
  );
  assert.match(q.sql, /\) OR \(/);
});

test("source 'manual' means no sourceUrl; negating a platform still matches manual uploads", () => {
  const manual = toQuery(parsed({ op: "AND", rules: [{ field: "source", value: "manual" }] }));
  assert.match(manual.sql, /source_url IS NULL/);
  // Platform matches run against COALESCE(source_url, '') so NOT(match) is
  // true — not NULL — for manual uploads (they'd silently vanish otherwise).
  const notMw = toQuery(
    parsed({ op: "AND", rules: [{ field: "source", value: "makerworld", negate: true }] }),
  );
  assert.match(notMw.sql, /COALESCE\(m\.source_url, ''\)/);
});

test("negated category match includes uncategorized models (NULL-safe compare)", () => {
  const q = toQuery(
    parsed({
      op: "AND",
      rules: [
        { field: "category", value: "5d3a4b1e-0000-0000-0000-000000000000", negate: true },
      ],
    }),
  );
  assert.match(q.sql, /IS NOT DISTINCT FROM/);
});

test("tags 'all' requires every listed tag via a distinct count", () => {
  const q = toQuery(
    parsed({
      op: "AND",
      rules: [{ field: "tags", op: "all", value: ["voron", "mods"] }],
    }),
  );
  assert.match(q.sql, /COUNT\(DISTINCT lower\(t\.name\)\)/);
  // The comparison count is the deduped list length.
  assert.ok(q.params.includes(2));
});

test("printer and filament match case-insensitively like /search", () => {
  const q = toQuery(
    parsed({
      op: "AND",
      rules: [
        { field: "printer", value: "Bambu Lab P1S" },
        { field: "filament", value: "PETG" },
      ],
    }),
  );
  assert.ok(q.params.includes("bambu lab p1s"));
  assert.ok(q.params.includes("petg"));
});
