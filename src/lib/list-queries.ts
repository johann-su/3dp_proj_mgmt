import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { type CatalogItem, hydrateCatalogRows } from "@/lib/catalog-hydrate";
import {
  decodeFeedCursor,
  encodeFeedCursor,
  feedSortIsModelOnly,
  type FeedSort,
} from "@/lib/feed-params";
import { PAGE_SIZE, type Page } from "@/lib/pagination";

// A single hit in the homepage feed — see CatalogItem in catalog-hydrate.ts.
export type FeedItem = CatalogItem;

// The temporal column a "newest"/"oldest"/"updated" sort ranks on. newest and
// oldest both order by created_at (only the direction differs); "updated"
// swaps in updated_at instead — see the models/collections.updatedAt columns,
// bumped on every edit.
function timeColumn(alias: "m" | "c", sort: FeedSort): SQL {
  const a = sql.raw(alias);
  return sort === "updated" ? sql`${a}.updated_at` : sql`${a}.created_at`;
}

// The numeric column "views"/"downloads" rank on; 0 (unused) for the time
// sorts. Downloads has no per-collection equivalent (model_files carries
// download_count, collections have nothing to sum), so this branch is only
// ever reached for the model half of the union — feedSortIsModelOnly keeps
// collections out of that query entirely.
function metricColumn(alias: "m" | "c", sort: FeedSort): SQL {
  const a = sql.raw(alias);
  if (sort === "views") return sql`${a}.view_count`;
  if (sort === "downloads") {
    return sql`(SELECT COALESCE(SUM(mf.download_count), 0) FROM model_files mf WHERE mf.model_id = m.id)`;
  }
  return sql`0`;
}

function whereClause(conds: SQL[]): SQL {
  return conds.length > 0 ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``;
}

// Cursor-paginated homepage feed of models and collections, ranked together
// by the requested sort. One UNION ALL query (mirroring src/lib/search.ts)
// selects a generic (sort_time, metric) pair per row so every sort shares one
// keyset scheme, then hydrateCatalogRows fills in the card data. A category
// filter narrows to models only (collections have no category); "downloads"
// does too, since it has no per-collection metric to rank them by.
export async function listFeed(opts: {
  categoryId?: string;
  cursor?: string | null;
  sort?: FeedSort;
}): Promise<Page<FeedItem>> {
  const sort = opts.sort ?? "newest";
  const includeCollections = !opts.categoryId && !feedSortIsModelOnly(sort);

  // Trashed models are hidden everywhere but the owner's trash page.
  const modelConds: SQL[] = [sql`m.deleted_at IS NULL`];
  if (opts.categoryId) modelConds.push(sql`m.category_id = ${opts.categoryId}`);

  const parts: SQL[] = [
    sql`SELECT m.id AS id, 'model' AS kind, ${timeColumn("m", sort)} AS sort_time, ${metricColumn("m", sort)} AS metric FROM models m ${whereClause(modelConds)}`,
  ];
  if (includeCollections) {
    parts.push(
      sql`SELECT c.id AS id, 'collection' AS kind, ${timeColumn("c", sort)} AS sort_time, ${metricColumn("c", sort)} AS metric FROM collections c`,
    );
  }
  const union = sql.join(parts, sql` UNION ALL `);

  // Keyset predicate + ordering. The tuple (sort key, id) is a stable total
  // order per query, so paging never skips or repeats a row.
  const cursor = opts.cursor ? decodeFeedCursor(opts.cursor) : null;
  let keyset: SQL = sql``;
  let orderBy: SQL;
  if (sort === "oldest") {
    if (cursor?.kind === "time") {
      const d = new Date(cursor.at);
      keyset = sql`WHERE (sort_time > ${d} OR (sort_time = ${d} AND id > ${cursor.id}))`;
    }
    orderBy = sql`sort_time ASC, id ASC`;
  } else if (sort === "views" || sort === "downloads") {
    if (cursor?.kind === "metric") {
      keyset = sql`WHERE (metric < ${cursor.value} OR (metric = ${cursor.value} AND id < ${cursor.id}))`;
    }
    orderBy = sql`metric DESC, id DESC`;
  } else {
    // newest / updated — same direction, they only differ in which column fed sort_time
    if (cursor?.kind === "time") {
      const d = new Date(cursor.at);
      keyset = sql`WHERE (sort_time < ${d} OR (sort_time = ${d} AND id < ${cursor.id}))`;
    }
    orderBy = sql`sort_time DESC, id DESC`;
  }

  const result = await db.execute<{
    id: string;
    kind: "model" | "collection";
    sort_time: Date;
    metric: number;
  }>(sql`
    SELECT id, kind, sort_time, metric
    FROM (${union}) AS matched
    ${keyset}
    ORDER BY ${orderBy}
    LIMIT ${PAGE_SIZE + 1}
  `);

  const rows = result.rows;
  const hasMore = rows.length > PAGE_SIZE;
  const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

  const items = await hydrateCatalogRows(pageRows);

  let nextCursor: string | null = null;
  if (hasMore && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1];
    nextCursor = encodeFeedCursor(
      sort === "views" || sort === "downloads"
        ? { kind: "metric", value: Number(last.metric), id: last.id }
        : { kind: "time", at: new Date(last.sort_time).toISOString(), id: last.id },
    );
  }

  return { items, nextCursor };
}
