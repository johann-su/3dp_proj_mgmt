import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import type { ModelCardData } from "@/components/model-card";
import type { CollectionCardData } from "@/components/collection-card";
import { fileSrc } from "@/lib/file-token";
import { PAGE_SIZE } from "@/lib/pagination";
import {
  decodeSearchCursor,
  effectiveSort,
  encodeSearchCursor,
  hasModelOnlyFilter,
  type SearchFilters,
} from "@/lib/search-params";

// A single hit in the combined (models ∪ collections) result stream. The two
// card shapes render differently, so the discriminant lets /search pick the
// right component.
export type SearchItem =
  | { kind: "model"; model: ModelCardData }
  | { kind: "collection"; collection: CollectionCardData };

export type SearchPage = { items: SearchItem[]; nextCursor: string | null };

// Escapes LIKE wildcards so a user typing "50%" searches for the literal text
// rather than "50 followed by anything".
function escapeLike(q: string): string {
  return q.replace(/[%_\\]/g, "\\$&");
}

// Fuzzy matching uses pg_trgm's *strict word* similarity, not whole-string
// similarity: a short query ("tlon") measured against a whole title
// ("Flightory Talon 1400") scores near-zero on similarity() — even an exact
// word like "talon" lands at ~0.29, below the 0.3 default — because the query
// shares few trigrams with the full string. strict_word_similarity() instead
// scores the best word-boundary-aligned match (talon→1.0, the typo tlon→0.375).
// Plain word_similarity() would work too but matches arbitrary substring
// extents, which inflates long descriptions into false positives (an unrelated
// model's blurb scores 0.5 for "talon"); the strict, word-aligned variant keeps
// those below ~0.25. The threshold is far looser than pg_trgm's 0.6 default so
// single-character typos still match (tlon 0.375, taln 0.375, talno 0.33) while
// unrelated text stays out.
const WORD_SIM_THRESHOLD = 0.3;

// The best word-aligned similarity of the query against a column. Used for both
// the match predicate and (as the max over title/description) relevance ranking.
function wordSim(col: SQL, q: string): SQL {
  return sql`strict_word_similarity(${q}, ${col})`;
}

// Matches the query against a model's tags. Only the model branch has tags
// (collections don't), so this is hardcoded to `m.id`.
function tagMatch(q: string, like: string): SQL {
  return sql`EXISTS (SELECT 1 FROM model_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.model_id = m.id AND (${wordSim(sql`t.name`, q)} >= ${WORD_SIM_THRESHOLD} OR t.name ILIKE ${like}))`;
}

// The best tag word-similarity for a model, as a scalar (0 when it has no
// matching tag). Feeds the relevance score so a strong tag hit ranks well.
function tagScore(q: string): SQL {
  return sql`COALESCE((SELECT MAX(${wordSim(sql`t.name`, q)}) FROM model_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.model_id = m.id), 0)`;
}

// The shared title/description + author predicate, parameterized by table
// alias ("m" for models, "c" for collections). A row matches when any searched
// field is word-similar to the query OR contains it as a substring (the ILIKE
// fallback guarantees exact substrings — e.g. "400" in "1400" — always match).
// Models additionally match on their tags.
function textConditions(alias: "m" | "c", f: SearchFilters): SQL[] {
  const conds: SQL[] = [];
  const a = sql.raw(alias);
  if (f.q) {
    const like = `%${escapeLike(f.q)}%`;
    const clauses: SQL[] = [
      sql`${wordSim(sql`${a}.title`, f.q)} >= ${WORD_SIM_THRESHOLD}`,
      sql`${wordSim(sql`${a}.description`, f.q)} >= ${WORD_SIM_THRESHOLD}`,
      sql`${a}.title ILIKE ${like}`,
      sql`${a}.description ILIKE ${like}`,
    ];
    if (alias === "m") clauses.push(tagMatch(f.q, like));
    conds.push(sql`(${sql.join(clauses, sql` OR `)})`);
  }
  if (f.userId) conds.push(sql`${a}.user_id = ${f.userId}`);
  return conds;
}

// Relevance: the best word similarity across title, description, and (for
// models) tags. Zero when there's no query (the caller sorts by recency then).
function scoreExpr(alias: "m" | "c", f: SearchFilters): SQL {
  const a = sql.raw(alias);
  if (!f.q) return sql`0`;
  const parts: SQL[] = [wordSim(sql`${a}.title`, f.q), wordSim(sql`${a}.description`, f.q)];
  if (alias === "m") parts.push(tagScore(f.q));
  return sql`GREATEST(${sql.join(parts, sql`, `)})`;
}

// The model-only filters (printer/filament/nozzle/print time) live on
// model_files, so each is an EXISTS over the model's files.
function modelFileConditions(f: SearchFilters): SQL[] {
  const conds: SQL[] = [];
  if (f.printer) {
    // Case-insensitive: "Bambu Lab P1S" and "bambu lab p1s" are the same printer.
    conds.push(
      sql`EXISTS (SELECT 1 FROM model_files mf WHERE mf.model_id = m.id AND lower(mf.printer_info->>'model') = ${f.printer.toLowerCase()})`,
    );
  }
  if (f.filaments.length > 0) {
    // OR within filament, matched case-insensitively ("ASA-AERO" == "ASA-Aero").
    // The CASE guards jsonb_array_elements_text against a non-array value (it
    // would otherwise throw); filamentTypes is always an array or absent.
    const lowered = sql.join(
      f.filaments.map((fil) => sql`${fil.toLowerCase()}`),
      sql`, `,
    );
    conds.push(
      sql`EXISTS (SELECT 1 FROM model_files mf WHERE mf.model_id = m.id AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(mf.printer_info->'filamentTypes') = 'array'
               THEN mf.printer_info->'filamentTypes' ELSE '[]'::jsonb END
        ) AS ft(v) WHERE lower(ft.v) IN (${lowered})
      ))`,
    );
  }
  if (f.nozzle !== undefined) {
    conds.push(
      sql`EXISTS (SELECT 1 FROM model_files mf WHERE mf.model_id = m.id AND (mf.printer_info->>'nozzleDiameterMm')::float = ${f.nozzle})`,
    );
  }
  if (f.maxPrintTime !== undefined) {
    conds.push(
      sql`EXISTS (SELECT 1 FROM model_files mf WHERE mf.model_id = m.id AND mf.print_time_seconds IS NOT NULL AND mf.print_time_seconds <= ${f.maxPrintTime})`,
    );
  }
  return conds;
}

function whereClause(conds: SQL[]): SQL {
  return conds.length > 0 ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``;
}

// Runs the combined search. Returns one keyset-paginated page ordered by the
// requested sort (relevance falls back to newest without a query term).
export async function search(
  f: SearchFilters,
  rawCursor?: string | null,
): Promise<SearchPage> {
  const sort = effectiveSort(f);
  const includeModels = f.type !== "collections";
  // Collections carry no printer metadata, so any model-only filter excludes
  // them regardless of the requested type.
  const includeCollections = f.type !== "models" && !hasModelOnlyFilter(f);

  if (!includeModels && !includeCollections) {
    return { items: [], nextCursor: null };
  }

  const parts: SQL[] = [];
  if (includeModels) {
    const conds = [...textConditions("m", f), ...modelFileConditions(f)];
    parts.push(
      sql`SELECT m.id AS id, 'model' AS kind, m.created_at AS created_at, ${scoreExpr("m", f)} AS score FROM models m ${whereClause(conds)}`,
    );
  }
  if (includeCollections) {
    const conds = textConditions("c", f);
    parts.push(
      sql`SELECT c.id AS id, 'collection' AS kind, c.created_at AS created_at, ${scoreExpr("c", f)} AS score FROM collections c ${whereClause(conds)}`,
    );
  }
  const union = sql.join(parts, sql` UNION ALL `);

  // Keyset predicate + ordering. The tuple (sort key, id) is a stable total
  // order per query, so paging never skips or repeats a row.
  const cursor = rawCursor ? decodeSearchCursor(rawCursor) : null;
  let keyset: SQL = sql``;
  let orderBy: SQL;
  if (sort === "relevance") {
    if (cursor?.kind === "score") {
      keyset = sql`WHERE (score < ${cursor.score} OR (score = ${cursor.score} AND id < ${cursor.id}))`;
    }
    orderBy = sql`score DESC, id DESC`;
  } else if (sort === "oldest") {
    if (cursor?.kind === "time") {
      const d = new Date(cursor.createdAt);
      keyset = sql`WHERE (created_at > ${d} OR (created_at = ${d} AND id > ${cursor.id}))`;
    }
    orderBy = sql`created_at ASC, id ASC`;
  } else {
    // newest
    if (cursor?.kind === "time") {
      const d = new Date(cursor.createdAt);
      keyset = sql`WHERE (created_at < ${d} OR (created_at = ${d} AND id < ${cursor.id}))`;
    }
    orderBy = sql`created_at DESC, id DESC`;
  }

  const result = await db.execute<{
    id: string;
    kind: "model" | "collection";
    created_at: Date;
    score: number;
  }>(sql`
    SELECT id, kind, created_at, score
    FROM (${union}) AS matched
    ${keyset}
    ORDER BY ${orderBy}
    LIMIT ${PAGE_SIZE + 1}
  `);

  const rows = result.rows;
  const hasMore = rows.length > PAGE_SIZE;
  const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

  const items = await hydrate(pageRows);

  let nextCursor: string | null = null;
  if (hasMore && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1];
    nextCursor = encodeSearchCursor(
      sort === "relevance"
        ? { kind: "score", score: Number(last.score), id: last.id }
        : { kind: "time", createdAt: new Date(last.created_at).toISOString(), id: last.id },
    );
  }

  return { items, nextCursor };
}

// Turns the bare (id, kind) result rows into fully-populated card data,
// preserving the ranked order. Models and collections are fetched in one query
// each (not one-per-row) and stitched back together by id.
async function hydrate(
  rows: { id: string; kind: "model" | "collection" }[],
): Promise<SearchItem[]> {
  const modelIds = rows.filter((r) => r.kind === "model").map((r) => r.id);
  const collectionIds = rows.filter((r) => r.kind === "collection").map((r) => r.id);

  const [modelRows, collectionRows] = await Promise.all([
    modelIds.length > 0
      ? db.query.models.findMany({
          where: (m, { inArray: within }) => within(m.id, modelIds),
          with: {
            user: { columns: { name: true } },
            category: true,
            files: {
              where: (fl, { eq }) => eq(fl.kind, "image"),
              orderBy: (fl, { asc }) => asc(fl.position),
              limit: 1,
            },
            modelTags: { with: { tag: true } },
          },
        })
      : Promise.resolve([]),
    collectionIds.length > 0
      ? db.query.collections.findMany({
          where: (c, { inArray: within }) => within(c.id, collectionIds),
          with: {
            user: { columns: { name: true } },
            collectionModels: {
              with: {
                model: {
                  columns: { id: true },
                  with: {
                    files: {
                      where: (fl, { eq }) => eq(fl.kind, "image"),
                      orderBy: (fl, { asc }) => asc(fl.position),
                      limit: 1,
                    },
                  },
                },
              },
            },
          },
        })
      : Promise.resolve([]),
  ]);

  const models = new Map<string, ModelCardData>(
    modelRows.map((m) => [
      m.id,
      {
        id: m.id,
        title: m.title,
        sourceUrl: m.sourceUrl,
        user: m.user,
        category: m.category,
        files: m.files.map((f) => ({ id: f.id, src: fileSrc(f.id) })),
        modelTags: m.modelTags,
      },
    ]),
  );
  const collections = new Map<string, CollectionCardData>(
    collectionRows.map((c) => [
      c.id,
      {
        id: c.id,
        title: c.title,
        user: c.user,
        collectionModels: c.collectionModels.map((cm) => ({
          model: {
            id: cm.model.id,
            files: cm.model.files.map((f) => ({ id: f.id, src: fileSrc(f.id) })),
          },
        })),
      },
    ]),
  );

  const items: SearchItem[] = [];
  for (const row of rows) {
    if (row.kind === "model") {
      const model = models.get(row.id);
      if (model) items.push({ kind: "model", model });
    } else {
      const collection = collections.get(row.id);
      if (collection) items.push({ kind: "collection", collection });
    }
  }
  return items;
}

// Distinct filter values present in the corpus, used to populate the /search
// sidebar. Kept simple (whole-corpus, not filter-aware) — the dataset is small
// and self-hosted.
export type SearchFacets = {
  users: { id: string; name: string }[];
  printers: string[];
  filaments: string[];
  nozzles: number[];
};

export async function searchFacets(): Promise<SearchFacets> {
  const [users, printers, filaments, nozzles] = await Promise.all([
    db.execute<{ id: string; name: string }>(sql`
      SELECT u.id, u.name FROM "user" u
      WHERE EXISTS (SELECT 1 FROM models m WHERE m.user_id = u.id)
         OR EXISTS (SELECT 1 FROM collections c WHERE c.user_id = u.id)
      ORDER BY u.name ASC
    `),
    db.execute<{ v: string }>(sql`
      SELECT DISTINCT printer_info->>'model' AS v FROM model_files
      WHERE printer_info->>'model' IS NOT NULL
      ORDER BY v ASC
    `),
    db.execute<{ v: string }>(sql`
      SELECT DISTINCT jsonb_array_elements_text(printer_info->'filamentTypes') AS v
      FROM model_files
      WHERE jsonb_typeof(printer_info->'filamentTypes') = 'array'
      ORDER BY v ASC
    `),
    db.execute<{ v: string }>(sql`
      SELECT DISTINCT printer_info->>'nozzleDiameterMm' AS v FROM model_files
      WHERE printer_info->>'nozzleDiameterMm' IS NOT NULL
      ORDER BY v ASC
    `),
  ]);

  return {
    users: users.rows,
    // Fold case variants ("ASA-AERO" / "ASA-Aero") into a single chip, keeping
    // the first (alphabetically) as the canonical label — the filters match
    // case-insensitively, so either label finds both.
    printers: dedupeCaseInsensitive(printers.rows.map((r) => r.v)),
    filaments: dedupeCaseInsensitive(filaments.rows.map((r) => r.v)),
    nozzles: nozzles.rows
      .map((r) => Number(r.v))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b),
  };
}

// Removes case-insensitive duplicates, preserving input order (first wins).
function dedupeCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}
