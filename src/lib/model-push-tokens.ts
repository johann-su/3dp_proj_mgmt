// Slice-push tokens (issue #122) — the DB side. The crypto (minting, hashing,
// header parsing) is pure and lives in src/lib/push-token.ts; this module only
// wires it to Postgres, so it is not unit-tested (it opens a pool at import).

import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { modelPushTokens, models } from "@/db/schema";
import { mintPushToken } from "@/lib/push-token";

// Tokens one model may hold at once — roughly "a slicer install per machine",
// with room to spare. A hard stop against a script looping on the mint action
// and growing the table without bound.
export const MAX_TOKENS_PER_MODEL = 10;

export type PushTokenSummary = {
  id: string;
  // Leading characters of the secret, so two tokens are tellable apart.
  prefix: string;
  label: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  // Whether the viewer issued this one. Anyone may add a token to a model
  // (editing is collaborative), so a model's list can span several users.
  mine: boolean;
};

export async function listModelPushTokens(
  modelId: string,
  viewerId: string,
): Promise<PushTokenSummary[]> {
  const rows = await db
    .select()
    .from(modelPushTokens)
    .where(eq(modelPushTokens.modelId, modelId))
    .orderBy(desc(modelPushTokens.createdAt));
  return rows.map((row) => ({
    id: row.id,
    prefix: row.prefix,
    label: row.label,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    mine: row.userId === viewerId,
  }));
}

// Every token the viewer issued, across all their models — the Settings list,
// which is where a token is revoked when you no longer remember which model
// it belonged to. Trashed models are excluded from the join like every other
// listing, but their tokens keep working until the model is restored or
// purged (the ingest route rejects a trashed target).
export async function listUserPushTokens(
  userId: string,
): Promise<(PushTokenSummary & { modelId: string; modelTitle: string })[]> {
  const rows = await db
    .select({
      token: modelPushTokens,
      modelTitle: models.title,
      deletedAt: models.deletedAt,
    })
    .from(modelPushTokens)
    .innerJoin(models, eq(models.id, modelPushTokens.modelId))
    .where(eq(modelPushTokens.userId, userId))
    .orderBy(desc(modelPushTokens.createdAt));
  return rows
    .filter((row) => row.deletedAt === null)
    .map((row) => ({
      id: row.token.id,
      prefix: row.token.prefix,
      label: row.token.label,
      createdAt: row.token.createdAt,
      lastUsedAt: row.token.lastUsedAt,
      mine: true,
      modelId: row.token.modelId,
      modelTitle: row.modelTitle,
    }));
}

// Mints a token and returns the plaintext — the only time it exists outside
// the pusher's slicer config. Only its SHA-256 is stored.
export async function createModelPushToken(
  modelId: string,
  userId: string,
  label: string | null,
): Promise<{ token: string; summary: PushTokenSummary }> {
  const minted = mintPushToken();
  const [row] = await db
    .insert(modelPushTokens)
    .values({
      modelId,
      userId,
      tokenHash: minted.tokenHash,
      prefix: minted.prefix,
      label,
    })
    .returning();
  return {
    token: minted.token,
    summary: {
      id: row.id,
      prefix: row.prefix,
      label: row.label,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      mine: true,
    },
  };
}

export async function countModelPushTokens(modelId: string): Promise<number> {
  const rows = await db
    .select({ id: modelPushTokens.id })
    .from(modelPushTokens)
    .where(eq(modelPushTokens.modelId, modelId));
  return rows.length;
}

export async function findPushToken(tokenId: string) {
  return db.query.modelPushTokens.findFirst({
    where: eq(modelPushTokens.id, tokenId),
  });
}

// Revocation is a row delete — that is the whole reason these are stored
// tokens rather than the stateless HMAC used for file downloads.
export async function deletePushToken(tokenId: string): Promise<void> {
  await db.delete(modelPushTokens).where(eq(modelPushTokens.id, tokenId));
}

export async function deleteOwnPushToken(
  tokenId: string,
  userId: string,
): Promise<void> {
  await db
    .delete(modelPushTokens)
    .where(
      and(eq(modelPushTokens.id, tokenId), eq(modelPushTokens.userId, userId)),
    );
}
