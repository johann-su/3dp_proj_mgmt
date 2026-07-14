"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { user } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { isAdmin, parseUserRole } from "@/lib/roles";

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
