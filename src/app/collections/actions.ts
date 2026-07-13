"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { collectionModels, collections, models } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { parseRuleTree, type RuleGroup } from "@/lib/collection-rules";

// Validates the smart/rules pair of a create/update input. Smart collections
// must carry a valid rule tree; manual ones store none (a stale tree left
// behind after toggling smart off would silently come back on re-enable with
// rules the user no longer sees).
function resolveRules(input: {
  smart: boolean;
  rules?: unknown;
}): { smart: boolean; rules: RuleGroup | null } | { error: string } {
  if (!input.smart) return { smart: false, rules: null };
  const parsed = parseRuleTree(input.rules);
  if ("error" in parsed) return { error: parsed.error };
  return { smart: true, rules: parsed.tree };
}

export async function createCollection(input: {
  title: string;
  description: string;
  smart?: boolean;
  rules?: unknown;
}): Promise<{ error: string } | never> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };

  const title = input.title.trim();
  if (!title) return { error: "Title is required" };

  const resolved = resolveRules({ smart: input.smart === true, rules: input.rules });
  if ("error" in resolved) return { error: resolved.error };

  const [collection] = await db
    .insert(collections)
    .values({
      title,
      description: input.description.trim(),
      userId: session.user.id,
      smart: resolved.smart,
      rules: resolved.rules,
    })
    .returning({ id: collections.id });

  revalidatePath("/");
  redirect(`/collections/${collection.id}`);
}

export async function updateCollection(input: {
  collectionId: string;
  title: string;
  description: string;
  smart?: boolean;
  rules?: unknown;
}): Promise<{ error: string } | never> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };

  const title = input.title.trim();
  if (!title) return { error: "Title is required" };

  const collection = await db.query.collections.findFirst({
    where: eq(collections.id, input.collectionId),
    columns: { id: true, userId: true, sourceUrl: true },
  });
  if (!collection) return { error: "Collection not found" };
  // Editing is open to any signed-in user (collaborative library); only
  // deletion stays owner-only. See deleteCollection.

  const resolved = resolveRules({ smart: input.smart === true, rules: input.rules });
  if ("error" in resolved) return { error: resolved.error };
  // Imported collections mirror an external MakerWorld list ("Sync" re-links
  // members); rule-based membership would fight that.
  if (resolved.smart && collection.sourceUrl) {
    return { error: "Imported collections can't be smart collections" };
  }

  await db
    .update(collections)
    .set({
      title,
      description: input.description.trim(),
      smart: resolved.smart,
      rules: resolved.rules,
      updatedAt: new Date(),
    })
    .where(eq(collections.id, collection.id));

  revalidatePath("/");
  revalidatePath(`/collections/${collection.id}`);
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
  // Deletion stays owner-only even though editing is open to everyone — losing
  // a collection is destructive and non-recoverable, unlike an edit.
  if (collection.userId !== session.user.id) return { error: "Not your collection" };

  await db.delete(collections).where(eq(collections.id, collectionId));

  revalidatePath("/");
  redirect("/");
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
  // Adding/removing models is an edit — open to any signed-in user, like the
  // rest of collection editing. Only deletion is owner-gated.
  // Smart membership is computed from the rules; there are no rows to toggle.
  if (collection.smart) {
    return { error: "Smart collections manage their models by rules" };
  }

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
  revalidatePath("/");
  return {};
}
