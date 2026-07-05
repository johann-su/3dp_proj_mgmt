"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth";
import { deleteOnshapeCredential } from "@/lib/onshape/credentials";

// Connecting happens via the OAuth redirect flow (/api/onshape/authorize);
// only disconnecting is a plain server action.
export async function disconnectOnshape(): Promise<{ error: string } | void> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };
  await deleteOnshapeCredential(session.user.id);
  revalidatePath("/settings/onshape");
}
