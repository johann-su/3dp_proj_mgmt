"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { modelDuplicates, models } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { isModerator } from "@/lib/roles";

// Resolving a dismissed duplicate flag (Settings → Duplicates, issue #118).
// Moderator/admin-only: the page hides for everyone else, but the gate is
// re-checked here — the page's check protects the page, not the action.
//
// Both actions only ever *resolve* a flag. Trashing goes through the same soft
// delete as the model page's own delete (deleted_at, restorable from the
// trash), never a purge: duplicate detection is advisory, and a false positive
// must not be able to destroy someone's model from a settings list.

async function requireModerator(): Promise<{ error: string } | null> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };
  if (!isModerator(session.user.role)) {
    return { error: "Only moderators can review duplicates" };
  }
  return null;
}

/** Drops the flag and leaves both models alone — "these aren't duplicates". */
export async function dismissDuplicate(
  id: string,
): Promise<{ error?: string }> {
  const denied = await requireModerator();
  if (denied) return denied;

  await db.delete(modelDuplicates).where(eq(modelDuplicates.id, id));
  revalidatePath("/settings/duplicates");
  return {};
}

/** Trashes the copy (restorable) and clears the flag it was listed under. */
export async function trashDuplicateModel(
  id: string,
): Promise<{ error?: string }> {
  const denied = await requireModerator();
  if (denied) return denied;

  const row = await db.query.modelDuplicates.findFirst({
    where: eq(modelDuplicates.id, id),
    columns: { modelId: true },
  });
  if (!row) return { error: "That duplicate has already been resolved" };

  await db.transaction(async (tx) => {
    await tx
      .update(models)
      .set({ deletedAt: new Date() })
      .where(eq(models.id, row.modelId));
    await tx.delete(modelDuplicates).where(eq(modelDuplicates.id, id));
  });

  revalidatePath("/");
  revalidatePath(`/models/${row.modelId}`);
  revalidatePath("/settings/duplicates");
  return {};
}
