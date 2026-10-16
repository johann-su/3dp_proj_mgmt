"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { categories, collectionPins, collections, modelPins, models } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { parseFeedSort } from "@/lib/feed-params";
import { listFeed, type FeedItem } from "@/lib/list-queries";
import type { Page } from "@/lib/pagination";
import type { PinKind } from "@/lib/pins";

// Fetches the next page of the homepage feed (models + collections interleaved)
// for endless scroll. The category slug and sort are echoed back from the
// client so the paged results match the currently displayed list.
export async function loadMoreFeed(input: {
  category?: string;
  sort?: string;
  cursor: string;
}): Promise<Page<FeedItem>> {
  // The catalog is private; an expired session just ends the endless scroll.
  const session = await getSession();
  if (!session) return { items: [], nextCursor: null };

  let categoryId: string | undefined;
  if (input.category) {
    const category = await db.query.categories.findFirst({
      where: eq(categories.slug, input.category),
      columns: { id: true },
    });
    // Unknown slug → no category filter, matching the homepage's "All" behavior.
    categoryId = category?.id;
  }

  return listFeed({ categoryId, cursor: input.cursor, sort: parseFeedSort(input.sort) });
}

// Pin/unpin a model or collection on the homepage. Pins are shared curation
// (everyone sees everyone's pins), so like editing, any signed-in user may pin
// or unpin anything. Not a model mutation — no versioning, no S3 bookkeeping.
export async function setHomePin(input: {
  kind: PinKind;
  id: string;
  pinned: boolean;
}): Promise<{ error?: string }> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };

  if (input.kind === "model") {
    const model = await db.query.models.findFirst({
      where: eq(models.id, input.id),
      columns: { id: true, deletedAt: true },
    });
    if (!model || model.deletedAt) return { error: "Model not found" };
    if (input.pinned) {
      await db
        .insert(modelPins)
        .values({ modelId: model.id, pinnedBy: session.user.id })
        .onConflictDoNothing();
    } else {
      await db.delete(modelPins).where(eq(modelPins.modelId, model.id));
    }
    revalidatePath(`/models/${model.id}`);
  } else if (input.kind === "collection") {
    const collection = await db.query.collections.findFirst({
      where: eq(collections.id, input.id),
      columns: { id: true },
    });
    if (!collection) return { error: "Collection not found" };
    if (input.pinned) {
      await db
        .insert(collectionPins)
        .values({ collectionId: collection.id, pinnedBy: session.user.id })
        .onConflictDoNothing();
    } else {
      await db.delete(collectionPins).where(eq(collectionPins.collectionId, collection.id));
    }
    revalidatePath(`/collections/${collection.id}`);
  } else {
    return { error: "Invalid pin target" };
  }

  revalidatePath("/");
  return {};
}
