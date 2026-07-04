"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { collectionModels, collections, models } from "@/db/schema";
import { getSession } from "@/lib/auth";

export async function createCollection(input: {
  title: string;
  description: string;
}): Promise<{ error: string } | never> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };

  const title = input.title.trim();
  if (!title) return { error: "Title is required" };

  const [collection] = await db
    .insert(collections)
    .values({
      title,
      description: input.description.trim(),
      userId: session.user.id,
    })
    .returning({ id: collections.id });

  revalidatePath("/collections");
  redirect(`/collections/${collection.id}`);
}

export async function deleteCollection(
  collectionId: string,
): Promise<{ error: string } | never> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };

  const collection = await db.query.collections.findFirst({
    where: eq(collections.id, collectionId),
  });
  if (!collection) return { error: "Collection not found" };
  if (collection.userId !== session.user.id) return { error: "Not your collection" };

  await db.delete(collections).where(eq(collections.id, collectionId));

  revalidatePath("/collections");
  redirect("/collections");
}

export async function toggleModelInCollection(input: {
  collectionId: string;
  modelId: string;
  inCollection: boolean;
}): Promise<{ error?: string }> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };

  const collection = await db.query.collections.findFirst({
    where: eq(collections.id, input.collectionId),
  });
  if (!collection) return { error: "Collection not found" };
  if (collection.userId !== session.user.id) return { error: "Not your collection" };

  const model = await db.query.models.findFirst({
    where: eq(models.id, input.modelId),
    columns: { id: true },
  });
  if (!model) return { error: "Model not found" };

  if (input.inCollection) {
    await db
      .insert(collectionModels)
      .values({ collectionId: input.collectionId, modelId: input.modelId })
      .onConflictDoNothing();
  } else {
    await db
      .delete(collectionModels)
      .where(
        and(
          eq(collectionModels.collectionId, input.collectionId),
          eq(collectionModels.modelId, input.modelId),
        ),
      );
  }

  revalidatePath(`/models/${input.modelId}`);
  revalidatePath(`/collections/${input.collectionId}`);
  revalidatePath("/collections");
  return {};
}
