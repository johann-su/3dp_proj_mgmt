import { db } from "@/db";
import type { ModelCardData } from "@/components/model-card";
import type { CollectionCardData } from "@/components/collection-card";
import { fileSrc } from "@/lib/file-token";
import { parametricExtra } from "@/lib/parametric";
import { smartCollectionPreviews } from "@/lib/smart-collections";

// A single hit in a combined (models ∪ collections) result stream — shared by
// /search and the homepage feed, both of which rank the two tables together
// and need the same two card shapes. The discriminant lets each grid pick the
// right component.
export type CatalogItem =
  | { kind: "model"; model: ModelCardData }
  | { kind: "collection"; collection: CollectionCardData };

// Turns the bare (id, kind) rows of a ranked models∪collections query into
// fully-populated card data, preserving the ranked order. Models and
// collections are fetched in one query each (not one-per-row) and stitched
// back together by id.
export async function hydrateCatalogRows(
  rows: { id: string; kind: "model" | "collection" }[],
): Promise<CatalogItem[]> {
  const modelIds = rows.filter((r) => r.kind === "model").map((r) => r.id);
  const collectionIds = rows.filter((r) => r.kind === "collection").map((r) => r.id);

  const [modelRows, collectionRows] = await Promise.all([
    modelIds.length > 0
      ? db.query.models.findMany({
          where: (m, { inArray: within }) => within(m.id, modelIds),
          extras: (m) => ({ parametric: parametricExtra(m.id) }),
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
        files: m.files.map((f) => ({
          id: f.id,
          src: fileSrc(f.id),
          animated: f.animated,
        })),
        modelTags: m.modelTags,
        parametric: m.parametric,
      },
    ]),
  );
  // Smart collections have no collection_models rows — their covers and count
  // come from evaluating the stored rules (see smart-collections.ts).
  const smartPreviews = await smartCollectionPreviews(
    collectionRows.filter((c) => c.smart).map((c) => ({ id: c.id, rules: c.rules })),
  );

  const collections = new Map<string, CollectionCardData>(
    collectionRows.map((c) => {
      const preview = smartPreviews.get(c.id);
      return [
        c.id,
        {
          id: c.id,
          title: c.title,
          user: c.user,
          smart: c.smart,
          totalModels: preview?.totalModels,
          collectionModels:
            preview?.collectionModels ??
            c.collectionModels.map((cm) => ({
              model: {
                id: cm.model.id,
                files: cm.model.files.map((f) => ({
                  id: f.id,
                  src: fileSrc(f.id),
                  animated: f.animated,
                })),
              },
            })),
        },
      ];
    }),
  );

  const items: CatalogItem[] = [];
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
