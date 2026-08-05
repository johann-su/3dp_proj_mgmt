import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { ModelCardData } from "@/components/model-card";
import { parseRuleTree, ruleTreeToSql } from "@/lib/collection-rules";
import { fileSrc } from "@/lib/file-token";
import { GALLERY_KINDS } from "@/lib/file-kind";
import { parametricExtra } from "@/lib/parametric";

// Runtime queries for smart collections: the stored rule tree is compiled to
// a WHERE clause and evaluated live against models — membership is never
// materialized (see issue #46 / AGENTS.md), so it can't go stale.
//
// Stored `rules` jsonb is re-validated through parseRuleTree before compiling
// (defense in depth: a row written before a schema change, or edited by hand,
// must degrade to "no matches", not reach the SQL compiler).

// Newest-first member ids for a rule tree. Smart membership has no addedAt,
// so recency of the model itself is the natural order (matches the homepage).
async function matchingModelIds(rules: unknown, limit: number): Promise<string[]> {
  const parsed = parseRuleTree(rules);
  if ("error" in parsed) return [];
  const result = await db.execute<{ id: string }>(sql`
    SELECT m.id FROM models m
    WHERE m.deleted_at IS NULL AND ${ruleTreeToSql(parsed.tree)}
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ${limit}
  `);
  return result.rows.map((r) => r.id);
}

// Broad rules can match the whole catalog; the collection page renders full
// cards for every member, so keep it bounded.
export const SMART_COLLECTION_PAGE_CAP = 200;

// Fully-populated member cards for the collection page, newest first.
export async function smartCollectionModelCards(
  rules: unknown,
): Promise<ModelCardData[]> {
  const ids = await matchingModelIds(rules, SMART_COLLECTION_PAGE_CAP);
  if (ids.length === 0) return [];

  const rows = await db.query.models.findMany({
    where: (m, { inArray }) => inArray(m.id, ids),
    extras: (m) => ({ parametric: parametricExtra(m.id) }),
    with: {
      user: { columns: { name: true } },
      category: true,
      files: {
        where: (f, { inArray }) => inArray(f.kind, GALLERY_KINDS),
        orderBy: (f, { asc }) => asc(f.position),
        limit: 1,
      },
      modelTags: { with: { tag: true } },
    },
  });

  const byId = new Map<string, ModelCardData>(
    rows.map((m) => [
      m.id,
      {
        id: m.id,
        title: m.title,
        sourceUrl: m.sourceUrl,
        user: m.user,
        category: m.category,
        files: m.files.map((f) => ({
          id: f.id,
          src: fileSrc(f.id),
          animated: f.animated,
          kind: f.kind,
        })),
        modelTags: m.modelTags,
        parametric: m.parametric,
      },
    ]),
  );
  return ids.map((id) => byId.get(id)).filter((m): m is ModelCardData => !!m);
}

// Cover images + member count for collection cards (browse grid, /search).
// Smart collections have no collection_models rows, so the card data the
// relational queries build is empty — this fills the same shape from the rules.
export type SmartCollectionPreview = {
  totalModels: number;
  collectionModels: {
    model: { id: string; files: { id: string; src: string; animated?: boolean }[] };
  }[];
};

export async function smartCollectionPreviews(
  cols: { id: string; rules: unknown }[],
): Promise<Map<string, SmartCollectionPreview>> {
  const previews = new Map<string, SmartCollectionPreview>();
  if (cols.length === 0) return previews;

  // One count + first-4-ids query per smart collection; pages show a handful
  // of collection cards at most, and each tree compiles to a different WHERE.
  const perCollection = await Promise.all(
    cols.map(async (c) => {
      const parsed = parseRuleTree(c.rules);
      if ("error" in parsed) return { id: c.id, total: 0, modelIds: [] as string[] };
      const result = await db.execute<{ id: string; total: number }>(sql`
        SELECT m.id, COUNT(*) OVER () AS total FROM models m
        WHERE m.deleted_at IS NULL AND ${ruleTreeToSql(parsed.tree)}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 4
      `);
      return {
        id: c.id,
        total: Number(result.rows[0]?.total ?? 0),
        modelIds: result.rows.map((r) => r.id),
      };
    }),
  );

  const allModelIds = [...new Set(perCollection.flatMap((p) => p.modelIds))];
  const coverRows =
    allModelIds.length > 0
      ? await db.query.models.findMany({
          where: (m, { inArray }) => inArray(m.id, allModelIds),
          columns: { id: true },
          with: {
            files: {
              where: (f, { inArray }) => inArray(f.kind, GALLERY_KINDS),
              orderBy: (f, { asc }) => asc(f.position),
              limit: 1,
            },
          },
        })
      : [];
  const coversByModel = new Map(
    coverRows.map((m) => [
      m.id,
      m.files.map((f) => ({
        id: f.id,
        src: fileSrc(f.id),
        animated: f.animated,
        kind: f.kind,
      })),
    ]),
  );

  for (const p of perCollection) {
    previews.set(p.id, {
      totalModels: p.total,
      collectionModels: p.modelIds.map((id) => ({
        model: { id, files: coversByModel.get(id) ?? [] },
      })),
    });
  }
  return previews;
}
