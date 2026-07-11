import { and, desc, eq } from "drizzle-orm";
import { parametricExtra } from "@/lib/parametric";
import { db } from "@/db";
import { collections, models } from "@/db/schema";
import type { ModelCardData } from "@/components/model-card";
import type { CollectionCardData } from "@/components/collection-card";
import { fileSrc } from "@/lib/file-token";
import {
  PAGE_SIZE,
  decodeCursor,
  keysetWhere,
  mergePage,
  type Page,
} from "@/lib/pagination";

// One entry in the homepage feed: a model or a collection card, tagged so the
// grid can pick the right component. `id`/`createdAt` are the keyset sort key
// shared by both tables, letting the two sources merge into one ordered page.
export type FeedItem = { id: string; createdAt: Date } & (
  | { type: "model"; model: ModelCardData }
  | { type: "collection"; collection: CollectionCardData }
);

// Cursor-paginated homepage feed of models and collections interleaved by
// recency. Both tables share the (createdAt desc, id desc) keyset, so each is
// over-fetched from the cursor and the two streams are merged into one page
// (see mergePage). A category filter narrows to models only — collections have
// no category — so filtered pages come from a single source.
export async function listFeed(opts: {
  categoryId?: string;
  cursor?: string | null;
}): Promise<Page<FeedItem>> {
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;

  const modelConditions = [];
  if (opts.categoryId) {
    modelConditions.push(eq(models.categoryId, opts.categoryId));
  }
  if (cursor) {
    modelConditions.push(keysetWhere(models.createdAt, models.id, cursor));
  }

  const modelRows = await db.query.models.findMany({
    where: modelConditions.length > 0 ? and(...modelConditions) : undefined,
    orderBy: [desc(models.createdAt), desc(models.id)],
    limit: PAGE_SIZE + 1,
    extras: (m) => ({ parametric: parametricExtra(m.id) }),
    with: {
      user: { columns: { name: true } },
      category: true,
      files: {
        where: (f, { eq }) => eq(f.kind, "image"),
        orderBy: (f, { asc }) => asc(f.position),
        limit: 1,
      },
      modelTags: { with: { tag: true } },
    },
  });

  const modelItems: FeedItem[] = modelRows.map((m) => ({
    id: m.id,
    createdAt: m.createdAt,
    type: "model",
    model: {
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
  }));

  let collectionItems: FeedItem[] = [];
  if (!opts.categoryId) {
    const collectionConditions = [];
    if (cursor) {
      collectionConditions.push(
        keysetWhere(collections.createdAt, collections.id, cursor),
      );
    }
    const collectionRows = await db.query.collections.findMany({
      where:
        collectionConditions.length > 0 ? and(...collectionConditions) : undefined,
      orderBy: [desc(collections.createdAt), desc(collections.id)],
      limit: PAGE_SIZE + 1,
      with: {
        user: { columns: { name: true } },
        collectionModels: {
          with: {
            model: {
              columns: { id: true },
              with: {
                files: {
                  where: (f, { eq }) => eq(f.kind, "image"),
                  orderBy: (f, { asc }) => asc(f.position),
                  limit: 1,
                },
              },
            },
          },
        },
      },
    });

    collectionItems = collectionRows.map((c) => ({
      id: c.id,
      createdAt: c.createdAt,
      type: "collection",
      collection: {
        id: c.id,
        title: c.title,
        user: c.user,
        collectionModels: c.collectionModels.map((cm) => ({
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
    }));
  }

  return mergePage([modelItems, collectionItems]);
}
