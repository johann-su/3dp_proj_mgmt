"use server";

// Mint/list/revoke the per-model slice-push tokens (issue #122). Minting is
// open to any signed-in user, like every other edit: a push token grants
// edit-equivalent access to one model, which is access the holder already
// has. Revoking is deliberately wider than minting — the model's owner (or a
// moderator/admin) can drop anyone's token on their model, because a
// credential pointed at your model is your business too.

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { models } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { canActAsOwner } from "@/lib/roles";
import {
  MAX_TOKENS_PER_MODEL,
  countModelPushTokens,
  createModelPushToken,
  deletePushToken,
  findPushToken,
  listModelPushTokens,
  type PushTokenSummary,
} from "@/lib/model-push-tokens";

// Dates cross the server/client boundary as ISO strings.
export type PushTokenView = Omit<
  PushTokenSummary,
  "createdAt" | "lastUsedAt"
> & {
  createdAt: string;
  lastUsedAt: string | null;
};

function toView(token: PushTokenSummary): PushTokenView {
  return {
    ...token,
    createdAt: token.createdAt.toISOString(),
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
  };
}

export async function listSlicePushTokens(
  modelId: string,
): Promise<{ tokens: PushTokenView[] } | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };

  const model = await db.query.models.findFirst({
    where: eq(models.id, modelId),
    columns: { id: true, deletedAt: true },
  });
  if (!model || model.deletedAt) return { error: "Model not found" };

  const tokens = await listModelPushTokens(modelId, session.user.id);
  return { tokens: tokens.map(toView) };
}

export async function createSlicePushToken(
  modelId: string,
  label: string,
): Promise<{ token: string; created: PushTokenView } | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };

  const model = await db.query.models.findFirst({
    where: eq(models.id, modelId),
    columns: { id: true, deletedAt: true },
  });
  if (!model || model.deletedAt) return { error: "Model not found" };

  if ((await countModelPushTokens(modelId)) >= MAX_TOKENS_PER_MODEL) {
    return {
      error: `This model already has ${MAX_TOKENS_PER_MODEL} push tokens — revoke one first.`,
    };
  }

  const trimmed = label.trim().slice(0, 80);
  const { token, summary } = await createModelPushToken(
    modelId,
    session.user.id,
    trimmed || null,
  );

  revalidatePath(`/models/${modelId}`);
  // The plaintext is returned exactly once and never stored; the caller shows
  // it and then can only ever display the prefix.
  return { token, created: toView(summary) };
}

export async function revokeSlicePushToken(
  tokenId: string,
): Promise<{ ok: true } | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };

  const token = await findPushToken(tokenId);
  if (!token) return { error: "Token not found" };

  const model = await db.query.models.findFirst({
    where: eq(models.id, token.modelId),
    columns: { id: true, userId: true },
  });
  // Your own token, or any token on a model you own (or moderate).
  const allowed =
    token.userId === session.user.id ||
    (!!model && canActAsOwner(session.user, model.userId));
  if (!allowed) return { error: "Not allowed" };

  await deletePushToken(tokenId);
  revalidatePath(`/models/${token.modelId}`);
  revalidatePath("/settings/slice-push");
  return { ok: true };
}
