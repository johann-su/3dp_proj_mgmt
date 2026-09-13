"use server";

// Mint/list/revoke slicer push tokens (issue #122). A token stands for one
// slicer install, so this is account settings, not model settings: every
// action here is scoped to the signed-in user and can only ever touch their
// own rows. The access a token carries — attach a file revision to a model —
// is access its owner already has, since editing is collaborative.

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth";
import {
  MAX_TOKENS_PER_USER,
  countPushTokens,
  createPushToken,
  deleteOwnPushToken,
} from "@/lib/push-tokens";
import { toPushTokenView, type PushTokenView } from "./token-view";

export async function createSlicePushToken(
  label: string,
): Promise<{ token: string; created: PushTokenView } | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };

  if ((await countPushTokens(session.user.id)) >= MAX_TOKENS_PER_USER) {
    return {
      error: `You already have ${MAX_TOKENS_PER_USER} push tokens — revoke one first.`,
    };
  }

  const trimmed = label.trim().slice(0, 80);
  const { token, summary } = await createPushToken(
    session.user.id,
    trimmed || null,
  );

  revalidatePath("/settings/slice-push");
  // The plaintext is returned exactly once and never stored; the caller shows
  // it and can only ever display the prefix afterwards.
  return { token, created: toPushTokenView(summary) };
}

export async function revokeSlicePushToken(
  tokenId: string,
): Promise<{ ok: true } | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };

  // Scoped in the DELETE itself: a token id is a guessable-shaped uuid, and
  // matching on (id, userId) means another account's row is never touched.
  await deleteOwnPushToken(tokenId, session.user.id);
  revalidatePath("/settings/slice-push");
  return { ok: true };
}
