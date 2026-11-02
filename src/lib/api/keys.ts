// The user-facing side of the api-key plugin's table, for Settings → API keys:
// list a user's keys and revoke one. Creating goes through the plugin
// (auth.api.createApiKey) because it hashes the key; reading and deleting
// rows is plain SQL, scoped to the owner.

import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { apikey } from "@/db/schema";
import { permissionsToScopes, type ApiScope } from "./scopes";

export type ApiKeySummary = {
  id: string;
  name: string | null;
  // The first characters (prefix included), so a user can match a key in a
  // config file to its row; the rest is only ever shown once, at creation.
  start: string | null;
  scopes: ApiScope[];
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
};

function parsePermissions(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function listApiKeys(userId: string): Promise<ApiKeySummary[]> {
  const rows = await db
    .select({
      id: apikey.id,
      name: apikey.name,
      start: apikey.start,
      permissions: apikey.permissions,
      createdAt: apikey.createdAt,
      lastRequest: apikey.lastRequest,
      expiresAt: apikey.expiresAt,
    })
    .from(apikey)
    .where(eq(apikey.referenceId, userId))
    .orderBy(desc(apikey.createdAt));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    start: row.start,
    scopes: permissionsToScopes(parsePermissions(row.permissions)),
    createdAt: row.createdAt,
    lastUsedAt: row.lastRequest,
    expiresAt: row.expiresAt,
  }));
}

// Revocation is immediate: every request re-verifies its key against this
// table. Scoped to the owner, so a key id from the browser can only ever pick
// one of the caller's own keys.
export async function revokeApiKey(userId: string, keyId: string): Promise<boolean> {
  const deleted = await db
    .delete(apikey)
    .where(and(eq(apikey.id, keyId), eq(apikey.referenceId, userId)))
    .returning({ id: apikey.id });
  return deleted.length > 0;
}
