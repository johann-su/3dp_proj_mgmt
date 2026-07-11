import { and, desc, eq, ilike, or } from "drizzle-orm";
import { parametricExtra } from "@/lib/parametric";
import { db } from "@/db";
import { collections, models } from "@/db/schema";
import type { ModelCardData } from "@/components/model-card";
import type { MyCollectionData } from "@/components/my-collection-card";
import { fileSrc } from "@/lib/file-token";
import {
  PAGE_SIZE,
  decodeCursor,
  keysetWhere,
  toPage,
  type Page,
} from "@/lib/pagination";

// Cursor-paginated homepage model listing, honoring the search query and
// category filter. Ordering matches keysetWhere: (createdAt desc, id desc).
export async function listModels(opts: {
  q?: string;
  categoryId?: string;
  cursor?: string | null;
}): Promise<Page<ModelCardData>> {
  const conditions = [];
  if (opts.q) {
    conditions.push(
      or(ilike(models.title, `%${opts.q}%`), ilike(models.description, `%${opts.q}%`)),
    );
  }
  if (opts.categoryId) {
    conditions.push(eq(models.categoryId, opts.categoryId));
  }
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
  if (cursor) {
    conditions.push(keysetWhere(models.createdAt, models.id, cursor));
  }

  const rows = await db.query.models.findMany({
    where: conditions.length > 0 ? and(...conditions) : undefined,
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

  const page = toPage(rows);
  const items: ModelCardData[] = page.items.map((m) => ({
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
  }));
  return { items, nextCursor: page.nextCursor };
}

// Cursor-paginated listing of a single user's collections.
export async function listUserCollections(opts: {
  userId: string;
  cursor?: string | null;
}): Promise<Page<MyCollectionData>> {
  const conditions = [eq(collections.userId, opts.userId)];
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
  if (cursor) {
    conditions.push(keysetWhere(collections.createdAt, collections.id, cursor));
  }

  const rows = await db.query.collections.findMany({
    where: and(...conditions),
    orderBy: [desc(collections.createdAt), desc(collections.id)],
    limit: PAGE_SIZE + 1,
    with: {
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

  const page = toPage(rows);
  const items: MyCollectionData[] = page.items.map((c) => ({
    id: c.id,
    title: c.title,
    collectionModels: c.collectionModels.map((cm) => ({
      model: {
        files: cm.model.files.map((f) => ({
          id: f.id,
          src: fileSrc(f.id),
          animated: f.animated,
        })),
      },
    })),
  }));
  return { items, nextCursor: page.nextCursor };
}
