"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { models, user } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { purgeModel } from "@/lib/model-versions";
import { isAdmin, parseUserRole } from "@/lib/roles";
import { reportError } from "@/lib/telemetry";

// Changes another user's instance role (Settings → Users). Admin-only — this
// is the one mutation in the app that is not open to moderators.
export async function setUserRole(input: {
  userId: string;
  role: string;
}): Promise<{ error?: string }> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };
  if (!isAdmin(session.user.role)) {
    return { error: "Only admins can change roles" };
  }

  const role = parseUserRole(input.role);
  if (!role) return { error: "Unknown role" };

  // Admins can't touch their own role: there is always someone left who can
  // undo a mistake, and a demotion can't silently lock the instance (only
  // INITIAL_ADMIN_EMAIL recovers a zero-admin database).
  if (input.userId === session.user.id) {
    return { error: "You can't change your own role" };
  }

  const updated = await db
    .update(user)
    .set({ role, updatedAt: new Date() })
    .where(eq(user.id, input.userId))
    .returning({ id: user.id });
  if (updated.length === 0) return { error: "User not found" };

  revalidatePath("/settings/users");
  return {};
}

// Permanently deletes an account and everything it owns (Settings → Users).
// Admin-only, like setUserRole. The user row's FK cascades take sessions,
// accounts, collections, Bambu/Onshape credentials and import jobs with it;
// version edits and generated variants on *other* users' models survive with
// the user reference nulled (see schema). Models can't ride that cascade —
// it would delete their rows but leak every S3 object — so each one is
// purged first (S3 objects incl. version snapshots, then rows).
export async function deleteUser(input: {
  userId: string;
}): Promise<{ error?: string }> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };
  if (!isAdmin(session.user.role)) {
    return { error: "Only admins can delete users" };
  }

  // Mirrors the self-role rule: an admin can't delete their own account, so
  // the instance always keeps at least one admin who can undo mistakes.
  if (input.userId === session.user.id) {
    return { error: "You can't delete your own account" };
  }

  const target = await db.query.user.findFirst({
    where: eq(user.id, input.userId),
    columns: { id: true },
  });
  if (!target) return { error: "User not found" };

  // Includes trashed models — trash is just a flag on the row.
  const owned = await db
    .select({ id: models.id })
    .from(models)
    .where(eq(models.userId, input.userId));
  try {
    for (const model of owned) await purgeModel(model.id);
  } catch (err) {
    // purgeModel deletes S3 before rows, so a failure leaves the remaining
    // models (and the account) intact — the admin simply retries.
    reportError(`Failed to purge models of user ${input.userId}`, err);
    return { error: "Failed to delete the user's models — try again" };
  }

  await db.delete(user).where(eq(user.id, input.userId));

  revalidatePath("/settings/users");
  return {};
}
