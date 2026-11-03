// Collection mutations shared by the server actions (src/app/collections/actions.ts) and the public API (src/app/api/v1/), so both apply the same rules. Callers authenticate; these authorize.

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { collectionModels, collections, models } from "@/db/schema";
import type { Actor, MutationError } from "@/lib/model-mutations";

// Adds a model to, or removes it from, a hand-picked collection. Membership is an edit — open to any signed-in user, like the rest of collection editing; only deletion is owner-gated. Idempotent both ways.
export async function setCollectionMembership(
  // Unused while membership edits are open to everyone; taken so the gate can tighten here without touching every caller.
  _actor: Actor,
  input: { collectionId: string; modelId: string; member: boolean },
): Promise<{ ok: true } | MutationError> {
  const collection = await db.query.collections.findFirst({
    where: eq(collections.id, input.collectionId),
    columns: { id: true, smart: true },
  });
  if (!collection) return { error: "Collection not found", code: "not_found" };
  // Smart membership is computed from the rules; there are no rows to toggle.
  if (collection.smart) {
    return { error: "Smart collections manage their models by rules", code: "invalid" };
  }

  const model = await db.query.models.findFirst({
    where: eq(models.id, input.modelId),
    columns: { id: true, deletedAt: true },
  });
  if (!model || model.deletedAt) return { error: "Model not found", code: "not_found" };

  if (input.member) {
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
  return { ok: true };
}
