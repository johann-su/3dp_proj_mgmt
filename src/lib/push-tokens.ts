// Slice-push tokens (issue #122) — the DB side. The crypto (minting, hashing,
// header parsing) is pure and lives in src/lib/push-token.ts; this module only
// wires it to Postgres, so it is not unit-tested (it opens a pool at import).
//
// A token stands for a *slicer install*, not a model: the plugin resolves the
// target model at slice time, so one token per machine covers the catalogue.
// See the table comment in src/db/schema.ts for why that trade is the right
// one, and docs/architecture/slicing.md for the flow.

import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { pushTokens } from "@/db/schema";
import {
  hashPushToken,
  mintPushToken,
  parsePushTokenHeader,
} from "@/lib/push-token";

// Tokens one user may hold at once — roughly "a slicer install per machine",
// with room to spare. A hard stop against a script looping on the mint action
// and growing the table without bound.
export const MAX_TOKENS_PER_USER = 10;

export type PushTokenSummary = {
  id: string;
  // Leading characters of the secret, so two tokens are tellable apart.
  prefix: string;
  label: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
};

function toSummary(row: typeof pushTokens.$inferSelect): PushTokenSummary {
  return {
    id: row.id,
    prefix: row.prefix,
    label: row.label,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

export async function listPushTokens(
  userId: string,
): Promise<PushTokenSummary[]> {
  const rows = await db
    .select()
    .from(pushTokens)
    .where(eq(pushTokens.userId, userId))
    .orderBy(desc(pushTokens.createdAt));
  return rows.map(toSummary);
}

export async function countPushTokens(userId: string): Promise<number> {
  const rows = await db
    .select({ id: pushTokens.id })
    .from(pushTokens)
    .where(eq(pushTokens.userId, userId));
  return rows.length;
}

// Mints a token and returns the plaintext — the only time it exists outside
// the slicer's plugin config. Only its SHA-256 is stored.
export async function createPushToken(
  userId: string,
  label: string | null,
): Promise<{ token: string; summary: PushTokenSummary }> {
  const minted = mintPushToken();
  const [row] = await db
    .insert(pushTokens)
    .values({
      userId,
      tokenHash: minted.tokenHash,
      prefix: minted.prefix,
      label,
    })
    .returning();
  return { token: minted.token, summary: toSummary(row) };
}

// Revocation is a row delete — that is the whole reason these are stored
// tokens rather than the stateless HMAC used for file downloads.
export async function deleteOwnPushToken(
  tokenId: string,
  userId: string,
): Promise<void> {
  await db
    .delete(pushTokens)
    .where(and(eq(pushTokens.id, tokenId), eq(pushTokens.userId, userId)));
}

// Authenticates a slice-push request from its Authorization header. Returns
// the token row's id and owner, or null — every caller answers a flat 401 so
// the header never reveals whether a well-formed token merely expired.
export async function authenticatePush(
  header: string | null,
): Promise<{ tokenId: string; userId: string } | null> {
  const token = parsePushTokenHeader(header);
  if (!token) return null;
  const row = await db.query.pushTokens.findFirst({
    where: eq(pushTokens.tokenHash, hashPushToken(token)),
  });
  return row ? { tokenId: row.id, userId: row.userId } : null;
}

// Bookkeeping only, and deliberately non-fatal at every call site: "when did
// this machine last push?" is what tells someone whether a token in the list
// is still wired up to a slicer.
export async function stampPushTokenUse(tokenId: string): Promise<void> {
  await db
    .update(pushTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(pushTokens.id, tokenId));
}
