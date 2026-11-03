"use server";

import { revalidatePath } from "next/cache";
import { apiEnabled, auth, getSession } from "@/lib/auth";
import { revokeApiKey } from "@/lib/api/keys";
import { parseScopes, scopesToPermissions } from "@/lib/api/scopes";
import { reportError } from "@/lib/telemetry";

// Offered lifetimes, in days; null = never expires.
const EXPIRY_DAYS = [30, 90, 365, null] as const;

// Creates a key for the signed-in user and returns the secret — the only time
// it is ever readable; only its hash is stored. Called server-side without
// request headers on purpose: that is what lets us set `permissions`, which
// the plugin refuses to accept from a client request.
export async function createApiKey(input: {
  name: string;
  scopes: unknown;
  expiresInDays: number | null;
}): Promise<{ key: string } | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };
  if (!apiEnabled) return { error: "The API is disabled on this instance" };

  const name = input.name.trim();
  if (!name || name.length > 64) return { error: "Name the key (at most 64 characters)" };
  const scopes = parseScopes(input.scopes);
  if ("error" in scopes) return scopes;
  if (!(EXPIRY_DAYS as readonly (number | null)[]).includes(input.expiresInDays)) {
    return { error: "Pick an expiry" };
  }

  try {
    const created = await auth.api.createApiKey({
      body: {
        name,
        userId: session.user.id,
        permissions: scopesToPermissions(scopes),
        expiresIn: input.expiresInDays === null ? null : input.expiresInDays * 86_400,
      },
    });
    revalidatePath("/settings/api-keys");
    return { key: created.key };
  } catch (err) {
    reportError("API key creation failed", err);
    return { error: "Couldn't create the key" };
  }
}

export async function deleteApiKey(keyId: string): Promise<{ error: string } | void> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };
  if (!keyId) return { error: "Missing key" };
  if (!(await revokeApiKey(session.user.id, keyId))) return { error: "Key not found" };
  revalidatePath("/settings/api-keys");
}
