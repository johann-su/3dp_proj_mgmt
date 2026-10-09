import { sql } from "drizzle-orm";
import { db } from "@/db";
import { type CatalogItem, hydrateCatalogRows } from "@/lib/catalog-hydrate";

// Pinned items cap: the section is a short, curated shelf, not a second feed.
export const MAX_PINNED = 48;

export type PinKind = "model" | "collection";

// The homepage "Pinned" section: every model and collection any user has
// pinned, most recently pinned first, as the same card data the feed uses.
// Pins are shared — there's no per-user filter. Trashed models keep their pin
// row (restoring brings the pin back) but are hidden here.
export async function listPinned(): Promise<CatalogItem[]> {
  const result = await db.execute<{ id: string; kind: PinKind }>(sql`
    SELECT id, kind FROM (
      SELECT p.model_id AS id, 'model' AS kind, p.created_at
      FROM model_pins p JOIN models m ON m.id = p.model_id
      WHERE m.deleted_at IS NULL
      UNION ALL
      SELECT p.collection_id AS id, 'collection' AS kind, p.created_at
      FROM collection_pins p
    ) AS pinned
    ORDER BY created_at DESC, id DESC
    LIMIT ${MAX_PINNED}
  `);
  return hydrateCatalogRows(result.rows);
}

// Whether a single model/collection is pinned, for the detail page's toggle.
export async function isPinned(kind: PinKind, id: string): Promise<boolean> {
  const row =
    kind === "model"
      ? await db.query.modelPins.findFirst({
          where: (p, { eq }) => eq(p.modelId, id),
          columns: { modelId: true },
        })
      : await db.query.collectionPins.findFirst({
          where: (p, { eq }) => eq(p.collectionId, id),
          columns: { collectionId: true },
        });
  return !!row;
}
