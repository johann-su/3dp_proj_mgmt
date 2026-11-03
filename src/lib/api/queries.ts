// The read side of /api/v1. Filtering reuses the smart-collection rule
// compiler (src/lib/collection-rules.ts), as the MCP search does, so the API
// filters exactly like the app's own saved searches. Every model listing
// filters `deleted_at IS NULL` (see docs/architecture/versioning.md).

import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { categories, collections, models } from "@/db/schema";
import {
  parseRuleTree,
  ruleTreeToSql,
  type RuleNode,
} from "@/lib/collection-rules";
import {
  encodeCursor,
  type Cursor,
  type ModelListQuery,
  type ModelSort,
} from "./params";
import type { ModelDetailRow, ModelSummaryRow } from "./serialize";

// Exact, DateStyle-independent text form of a timestamp for cursors — see
// params.ts for why it isn't a JS Date.
const cursorText = (col: SQL) => sql`to_char(${col}, 'YYYY-MM-DD HH24:MI:SS.US')`;

const SORT_COLUMN: Record<ModelSort, { col: SQL; desc: boolean }> = {
  created_desc: { col: sql`m.created_at`, desc: true },
  created_asc: { col: sql`m.created_at`, desc: false },
  updated_desc: { col: sql`m.updated_at`, desc: true },
  updated_asc: { col: sql`m.updated_at`, desc: false },
};

function keyset(col: SQL, idCol: SQL, desc: boolean, cursor: Cursor | null): SQL | null {
  if (!cursor) return null;
  const at = sql`${cursor.at}::timestamp`;
  return desc
    ? sql`(${col} < ${at} OR (${col} = ${at} AND ${idCol} < ${cursor.id}::uuid))`
    : sql`(${col} > ${at} OR (${col} = ${at} AND ${idCol} > ${cursor.id}::uuid))`;
}

// Membership of a collection as a predicate over `models m`: rows for a
// hand-picked one, its live rule tree for a smart one (never materialized —
// see src/lib/smart-collections.ts). An unparsable stored tree matches
// nothing rather than reaching the compiler.
export async function collectionMembershipSql(collectionId: string): Promise<SQL | null> {
  const collection = await db.query.collections.findFirst({
    where: eq(collections.id, collectionId),
    columns: { smart: true, rules: true },
  });
  if (!collection) return null;
  if (!collection.smart) {
    return sql`EXISTS (SELECT 1 FROM collection_models cm WHERE cm.model_id = m.id AND cm.collection_id = ${collectionId})`;
  }
  const parsed = parseRuleTree(collection.rules);
  return "error" in parsed ? sql`false` : ruleTreeToSql(parsed.tree);
}

// Summary rows for these ids in the given order — the second half of a
// ranked listing, one query per relation rather than one per row.
async function modelSummaries(ids: string[]): Promise<ModelSummaryRow[]> {
  if (ids.length === 0) return [];
  const rows = await db.query.models.findMany({
    where: (m) => inArray(m.id, ids),
    with: {
      user: { columns: { id: true, name: true } },
      category: { columns: { id: true, name: true, slug: true } },
      modelTags: { with: { tag: { columns: { name: true } } } },
      files: {
        where: (f, { eq: equals }) => equals(f.kind, "image"),
        orderBy: (f, { asc: ascending }) => ascending(f.position),
        limit: 1,
        columns: { id: true },
      },
    },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    if (!row) return [];
    return [
      {
        id: row.id,
        title: row.title,
        category: row.category,
        tags: row.modelTags.map((mt) => mt.tag.name),
        owner: row.user,
        sourceUrl: row.sourceUrl,
        sourceRevision: row.sourceRevision,
        coverImageId: row.files[0]?.id ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
    ];
  });
}

export async function listModels(
  query: ModelListQuery & { ownerId?: string; membership?: SQL },
): Promise<{ rows: ModelSummaryRow[]; nextCursor: string | null }> {
  const rules: RuleNode[] = [];
  if (query.q) rules.push({ field: "text", value: query.q });
  if (query.categoryId) rules.push({ field: "category", value: query.categoryId });
  if (query.tags.length > 0) rules.push({ field: "tags", op: "any", value: query.tags });
  if (query.source) rules.push({ field: "source", value: query.source });
  if (query.ownerId) rules.push({ field: "uploader", value: query.ownerId });

  const { col, desc } = SORT_COLUMN[query.sort];
  const conds: SQL[] = [sql`m.deleted_at IS NULL`];
  if (rules.length > 0) conds.push(ruleTreeToSql({ op: "AND", rules }));
  if (query.updatedSince) conds.push(sql`m.updated_at >= ${query.updatedSince}`);
  if (query.membership) conds.push(query.membership);
  const page = keyset(col, sql`m.id`, desc, query.cursor);
  if (page) conds.push(page);

  const dir = desc ? sql`DESC` : sql`ASC`;
  const { rows } = await db.execute<{ id: string; at: string }>(sql`
    SELECT m.id, ${cursorText(col)} AS at
    FROM models m
    WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY ${col} ${dir}, m.id ${dir}
    LIMIT ${query.limit + 1}
  `);

  const hasMore = rows.length > query.limit;
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    rows: await modelSummaries(pageRows.map((r) => r.id)),
    nextCursor: hasMore && last ? encodeCursor(query.sort, last.at, last.id) : null,
  };
}

export async function getModelDetail(modelId: string): Promise<ModelDetailRow | null> {
  const row = await db.query.models.findFirst({
    where: and(eq(models.id, modelId), isNull(models.deletedAt)),
    with: {
      user: { columns: { id: true, name: true } },
      category: { columns: { id: true, name: true, slug: true } },
      modelTags: { with: { tag: { columns: { name: true } } } },
      files: true,
      bomItems: { orderBy: (b, { asc: ascending }) => ascending(b.position) },
    },
  });
  if (!row) return null;
  const files = [...row.files].sort((a, b) => a.position - b.position);
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    tags: row.modelTags.map((mt) => mt.tag.name),
    owner: row.user,
    sourceUrl: row.sourceUrl,
    sourceRevision: row.sourceRevision,
    coverImageId: files.find((f) => f.kind === "image")?.id ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    files,
    bom: row.bomItems.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      link: item.link,
      imageUrl: item.imageUrl,
      section: item.section,
    })),
    videos: row.videos,
  };
}

export async function listCategories() {
  return db
    .select({ id: categories.id, name: categories.name, slug: categories.slug })
    .from(categories)
    .orderBy(asc(categories.name));
}

// Tags with how many live models carry them; unused tags are left out.
export async function listTags(): Promise<{ name: string; modelCount: number }[]> {
  const { rows } = await db.execute<{ name: string; model_count: number }>(sql`
    SELECT t.name, COUNT(*)::int AS model_count
    FROM tags t
    JOIN model_tags mt ON mt.tag_id = t.id
    JOIN models m ON m.id = mt.model_id AND m.deleted_at IS NULL
    GROUP BY t.name
    ORDER BY t.name
  `);
  return rows.map((r) => ({ name: r.name, modelCount: r.model_count }));
}

const collectionColumns = {
  id: true,
  title: true,
  description: true,
  smart: true,
  sourceUrl: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function listCollections(opts: { limit: number; cursor: Cursor | null }) {
  const page = keyset(sql`c.created_at`, sql`c.id`, true, opts.cursor);
  const { rows } = await db.execute<{ id: string; at: string }>(sql`
    SELECT c.id, ${cursorText(sql`c.created_at`)} AS at
    FROM collections c
    ${page ? sql`WHERE ${page}` : sql``}
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT ${opts.limit + 1}
  `);
  const hasMore = rows.length > opts.limit;
  const pageRows = hasMore ? rows.slice(0, opts.limit) : rows;
  const ids = pageRows.map((r) => r.id);
  const found =
    ids.length > 0
      ? await db.query.collections.findMany({
          where: (c) => inArray(c.id, ids),
          columns: collectionColumns,
          with: { user: { columns: { id: true, name: true } } },
        })
      : [];
  const byId = new Map(found.map((c) => [c.id, { ...c, owner: c.user }]));
  const last = pageRows[pageRows.length - 1];
  return {
    rows: ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
    nextCursor: hasMore && last ? encodeCursor("created_desc", last.at, last.id) : null,
  };
}

export async function getCollection(collectionId: string) {
  const row = await db.query.collections.findFirst({
    where: eq(collections.id, collectionId),
    columns: collectionColumns,
    with: { user: { columns: { id: true, name: true } } },
  });
  return row ? { ...row, owner: row.user } : null;
}
