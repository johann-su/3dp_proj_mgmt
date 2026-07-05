"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth";
import { getSessionInfo, OnshapeError } from "@/lib/onshape/api";
import {
  deleteOnshapeCredential,
  saveOnshapeCredential,
} from "@/lib/onshape/credentials";

export async function connectOnshape(input: {
  accessKey: string;
  secretKey: string;
}): Promise<{ status: "connected" } | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };

  const accessKey = input.accessKey.trim();
  const secretKey = input.secretKey.trim();
  if (!accessKey || !secretKey) {
    return { error: "Enter both the access key and the secret key" };
  }

  // Validate the pair with a cheap authenticated call before storing it; this
  // also yields a display name for the settings page.
  let account: string;
  try {
    const info = await getSessionInfo({ accessKey, secretKey });
    account = info.email || info.name || accessKey;
  } catch (err) {
    if (err instanceof OnshapeError && err.status === 401) {
      return { error: "Onshape rejected these API keys — check for typos" };
    }
    return {
      error: err instanceof Error ? err.message : "Could not reach Onshape",
    };
  }

  await saveOnshapeCredential(session.user.id, account, { accessKey, secretKey });
  revalidatePath("/settings/onshape");
  return { status: "connected" };
}

export async function disconnectOnshape(): Promise<{ error: string } | void> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };
  await deleteOnshapeCredential(session.user.id);
  revalidatePath("/settings/onshape");
}
