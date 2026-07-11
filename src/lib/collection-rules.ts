import { sql, type SQL } from "drizzle-orm";

// Smart-collection rules (issue #46): a collection can define its membership
// as a rule tree evaluated against model metadata instead of hand-picked
// `collection_models` rows. The tree is the Lightroom/Smart-Playlist shape —
// nested AND/OR groups of field/value conditions with per-condition negation —
// stored as jsonb on `collections.rules` and compiled to a SQL predicate over
// the `models m` alias at read time (mirroring how /search builds its WHERE,
// see src/lib/search.ts).
//
// This module is DB-free on purpose: parsing/validation and the SQL compiler
// are pure (drizzle's `sql` tag builds parameterized fragments without a
// connection), so both are unit-testable. The queries that execute the
// compiled predicate live in src/lib/smart-collections.ts.

export type RuleGroupOp = "AND" | "OR";

export type SourcePlatformValue =
  | "makerworld"
  | "printables"
  | "onshape"
  | "manual";

export type RuleCondition =
  // has any/all of the listed tags (negate for "none"/"not all")
  | { field: "tags"; op: "any" | "all"; value: string[]; negate?: boolean }
  | { field: "category"; value: string; negate?: boolean } // category id
  | { field: "uploader"; value: string; negate?: boolean } // user id
  | { field: "source"; value: SourcePlatformValue; negate?: boolean }
  | { field: "printer"; value: string; negate?: boolean } // printer_info->>'model'
  | { field: "filament"; value: string; negate?: boolean } // any file uses it
  | { field: "nozzle"; value: number; negate?: boolean } // mm
  | { field: "printTime"; value: number; negate?: boolean } // any file ≤ seconds
  | { field: "parametric"; negate?: boolean } // ships a .scad source
  | { field: "addedWithin"; value: number; negate?: boolean } // last N days
  | { field: "text"; value: string; negate?: boolean } // title/description match
  | { field: "downloads"; value: number; negate?: boolean }; // total ≥ N

export type RuleField = RuleCondition["field"];

export type RuleGroup = { op: RuleGroupOp; rules: RuleNode[] };
export type RuleNode = RuleGroup | RuleCondition;

export function isRuleGroup(node: RuleNode): node is RuleGroup {
  return "rules" in node;
}

// UI labels for the rule-builder field dropdown, in display order.
export const RULE_FIELD_LABELS: Record<RuleField, string> = {
  tags: "Tags",
  category: "Category",
  uploader: "Uploaded by",
  source: "Source",
  printer: "Printer",
  filament: "Filament",
  nozzle: "Nozzle diameter",
  printTime: "Print time",
  parametric: "Parametric (OpenSCAD)",
  addedWithin: "Added within",
  text: "Title or description",
  downloads: "Downloads",
};

export const SOURCE_VALUE_LABELS: Record<SourcePlatformValue, string> = {
  makerworld: "MakerWorld",
  printables: "Printables",
  onshape: "Onshape",
  manual: "Manual upload",
};

// Guardrails against pathological trees (the compile is recursive and each
// condition costs a subquery). Depth counts the root group as 1.
export const MAX_RULE_DEPTH = 3;
export const MAX_RULE_CONDITIONS = 32;
// Matches the per-model tag cap in normalizeTagNames (src/lib/tags.ts).
export const MAX_TAGS_PER_CONDITION = 20;

// --- Validation -----------------------------------------------------------

// Parses an untrusted jsonb value (form input or a stored rules column) into a
// typed rule tree. Returns an error message instead of throwing so server
// actions can surface it. Everything not exactly matching the schema is
// rejected — the tree is compiled into SQL, so no unknown shapes may pass
// (values themselves are always bound as query parameters, never spliced).
export function parseRuleTree(
  input: unknown,
): { tree: RuleGroup } | { error: string } {
  const counter = { conditions: 0 };
  const result = parseGroup(input, 1, counter);
  if (typeof result === "string") return { error: result };
  if (counter.conditions === 0) return { error: "Add at least one condition" };
  return { tree: result };
}

function parseGroup(
  input: unknown,
  depth: number,
  counter: { conditions: number },
): RuleGroup | string {
  if (depth > MAX_RULE_DEPTH) return `Groups nest at most ${MAX_RULE_DEPTH} deep`;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "Rule group must be an object";
  }
  const g = input as Record<string, unknown>;
  if (g.op !== "AND" && g.op !== "OR") return "Group op must be AND or OR";
  if (!Array.isArray(g.rules)) return "Group rules must be an array";
  if (g.rules.length === 0) return "Groups need at least one rule";

  const rules: RuleNode[] = [];
  for (const raw of g.rules) {
    const isGroup =
      typeof raw === "object" && raw !== null && "rules" in (raw as object);
    const parsed = isGroup
      ? parseGroup(raw, depth + 1, counter)
      : parseCondition(raw, counter);
    if (typeof parsed === "string") return parsed;
    rules.push(parsed);
  }
  return { op: g.op, rules };
}

function parseCondition(
  input: unknown,
  counter: { conditions: number },
): RuleCondition | string {
  if (typeof input !== "object" || input === null) {
    return "Rule condition must be an object";
  }
  if (++counter.conditions > MAX_RULE_CONDITIONS) {
    return `At most ${MAX_RULE_CONDITIONS} conditions per collection`;
  }
  const c = input as Record<string, unknown>;
  const negate = c.negate === true;

  switch (c.field) {
    case "tags": {
      if (c.op !== "any" && c.op !== "all") return "Tag match must be any or all";
      if (!Array.isArray(c.value)) return "Tags must be a list";
      const tags = [
        ...new Set(
          c.value
            .filter((t): t is string => typeof t === "string")
            .map((t) => t.trim().toLowerCase())
            .filter(Boolean),
        ),
      ];
      if (tags.length === 0) return "Pick at least one tag";
      if (tags.length > MAX_TAGS_PER_CONDITION) {
        return `At most ${MAX_TAGS_PER_CONDITION} tags per condition`;
      }
      return { field: "tags", op: c.op, value: tags, negate };
    }
    case "category":
    case "uploader":
    case "printer":
    case "filament":
    case "text": {
      if (typeof c.value !== "string" || c.value.trim() === "") {
        return `${RULE_FIELD_LABELS[c.field]} needs a value`;
      }
      return { field: c.field, value: c.value.trim(), negate };
    }
    case "source": {
      if (
        c.value !== "makerworld" &&
        c.value !== "printables" &&
        c.value !== "onshape" &&
        c.value !== "manual"
      ) {
        return "Unknown source platform";
      }
      return { field: "source", value: c.value, negate };
    }
    case "nozzle":
    case "printTime":
    case "addedWithin":
    case "downloads": {
      const n = typeof c.value === "number" ? c.value : NaN;
      if (!Number.isFinite(n) || n <= 0) {
        return `${RULE_FIELD_LABELS[c.field]} needs a positive number`;
      }
      return { field: c.field, value: n, negate };
    }
    case "parametric":
      return { field: "parametric", negate };
    default:
      return "Unknown rule field";
  }
}

// --- SQL compilation --------------------------------------------------------

// Same fuzzy-match tuning as /search — see the WORD_SIM_THRESHOLD comment in
// src/lib/search.ts for why strict_word_similarity at 0.3.
const WORD_SIM_THRESHOLD = 0.3;

function escapeLike(q: string): string {
  return q.replace(/[%_\\]/g, "\\$&");
}

// Hostname patterns mirroring platformFromSourceUrl (src/lib/platform.ts),
// expressed as SQL regexes so classification happens in the WHERE clause.
const SOURCE_HOST_PATTERNS: Record<Exclude<SourcePlatformValue, "manual">, string> = {
  makerworld: "^https?://([^/]*\\.)?makerworld\\.com(/|$)",
  printables: "^https?://([^/]*\\.)?printables\\.com(/|$)",
  onshape: "^https?://([^/]*\\.)?onshape\\.com(/|$)",
};

// Compiles a validated rule tree into one boolean SQL expression over the
// `models m` alias (subqueries reach into model_files/model_tags/tags, the
// same shapes as search.ts's modelFileConditions/tagMatch). All user values
// are bound parameters. Every condition is written to be NULL-safe so that
// `negate` behaves as users expect — e.g. "NOT category = X" must include
// uncategorized models, which a bare `NOT (m.category_id = X)` would drop
// (NULL, not true).
export function ruleTreeToSql(tree: RuleGroup): SQL {
  return groupSql(tree);
}

function groupSql(group: RuleGroup): SQL {
  const parts = group.rules.map((node) =>
    isRuleGroup(node) ? groupSql(node) : conditionSql(node),
  );
  const joined = sql.join(parts, group.op === "AND" ? sql` AND ` : sql` OR `);
  return sql`(${joined})`;
}

function conditionSql(cond: RuleCondition): SQL {
  const expr = fieldSql(cond);
  return cond.negate ? sql`NOT ${expr}` : expr;
}

// One EXISTS per model's files, with the given predicate on the `mf` alias.
function fileExists(predicate: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM model_files mf WHERE mf.model_id = m.id AND ${predicate})`;
}

function fieldSql(cond: RuleCondition): SQL {
  switch (cond.field) {
    case "tags": {
      const list = sql.join(
        cond.value.map((t) => sql`${t}`),
        sql`, `,
      );
      if (cond.op === "any") {
        return sql`(EXISTS (SELECT 1 FROM model_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.model_id = m.id AND lower(t.name) IN (${list})))`;
      }
      // "all": the model carries every listed tag (values are pre-deduped and
      // lowercased by parseRuleTree, so a distinct count comparison works).
      return sql`((SELECT COUNT(DISTINCT lower(t.name)) FROM model_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.model_id = m.id AND lower(t.name) IN (${list})) = ${cond.value.length})`;
    }
    case "category":
      // IS NOT DISTINCT FROM: false (not NULL) for uncategorized models, so
      // negation includes them.
      return sql`(m.category_id IS NOT DISTINCT FROM ${cond.value}::uuid)`;
    case "uploader":
      return sql`(m.user_id = ${cond.value})`;
    case "source": {
      if (cond.value === "manual") return sql`(m.source_url IS NULL)`;
      // COALESCE keeps the match false (not NULL) for manual uploads.
      return sql`(COALESCE(m.source_url, '') ~* ${SOURCE_HOST_PATTERNS[cond.value]})`;
    }
    case "printer":
      return sql`(${fileExists(sql`lower(mf.printer_info->>'model') = ${cond.value.toLowerCase()}`)})`;
    case "filament":
      // Same jsonb_typeof guard as search.ts: filamentTypes is an array or absent.
      return sql`(${fileExists(sql`EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(mf.printer_info->'filamentTypes') = 'array'
               THEN mf.printer_info->'filamentTypes' ELSE '[]'::jsonb END
        ) AS ft(v) WHERE lower(ft.v) = ${cond.value.toLowerCase()}
      )`)})`;
    case "nozzle":
      return sql`(${fileExists(sql`(mf.printer_info->>'nozzleDiameterMm')::float = ${cond.value}`)})`;
    case "printTime":
      return sql`(${fileExists(sql`mf.print_time_seconds IS NOT NULL AND mf.print_time_seconds <= ${cond.value}`)})`;
    case "parametric":
      // Same predicate as parametricExtra (src/lib/parametric.ts).
      return sql`(${fileExists(sql`mf.filename ILIKE '%.scad'`)})`;
    case "addedWithin":
      return sql`(m.created_at >= now() - make_interval(days => ${cond.value}))`;
    case "text": {
      const like = `%${escapeLike(cond.value)}%`;
      return sql`(strict_word_similarity(${cond.value}, m.title) >= ${WORD_SIM_THRESHOLD} OR strict_word_similarity(${cond.value}, m.description) >= ${WORD_SIM_THRESHOLD} OR m.title ILIKE ${like} OR m.description ILIKE ${like})`;
    }
    case "downloads":
      return sql`((SELECT COALESCE(SUM(mf.download_count), 0) FROM model_files mf WHERE mf.model_id = m.id) >= ${cond.value})`;
  }
}
