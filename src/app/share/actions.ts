"use server";

import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  collectionShareLinks,
  collections,
  modelShareLinks,
  models,
} from "@/db/schema";
import { getSession } from "@/lib/auth";
import { canActAsOwner } from "@/lib/roles";
import type { ShareKind } from "@/lib/share-links";
import { generateShareToken, publicSharingEnabled } from "@/lib/share-token";

// Turn an item's public link on or off. Asymmetric on purpose:
//  - enabling publishes the item outside the instance (it may be a paid
//    model), so it is an owner decision — canActAsOwner, like deletion;
//  - revoking only ever makes things more private, so any signed-in member
//    may do it (someone who spots a paid model shared publicly can stop it).
// Revoking deletes the row; enabling again mints a new token, so the old URL
// stays dead. Enabling an already-public item returns the existing link.
export async function setPublicShare(input: {
  kind: ShareKind;
  id: string;
  enabled: boolean;
}): Promise<{ token: string | null } | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };
  if (input.enabled && !publicSharingEnabled()) {
    return { error: "Public links are disabled on this instance" };
  }

  if (input.kind === "model") {
    const model = await db.query.models.findFirst({
      where: eq(models.id, input.id),
      columns: { id: true, userId: true, deletedAt: true },
    });
    if (!model || model.deletedAt) return { error: "Model not found" };
    if (!input.enabled) {
      await db.delete(modelShareLinks).where(eq(modelShareLinks.modelId, model.id));
      return { token: null };
    }
    if (!canActAsOwner(session.user, model.userId)) {
      return { error: "Only the owner can create a public link" };
    }
    const [row] = await db
      .insert(modelShareLinks)
      .values({ modelId: model.id, token: generateShareToken(), createdBy: session.user.id })
      .onConflictDoUpdate({
        // No-op update so RETURNING yields the existing (still valid) token.
        target: modelShareLinks.modelId,
        set: { modelId: model.id },
      })
      .returning({ token: modelShareLinks.token });
    return { token: row.token };
  }

  if (input.kind === "collection") {
    const collection = await db.query.collections.findFirst({
      where: eq(collections.id, input.id),
      columns: { id: true, userId: true },
    });
    if (!collection) return { error: "Collection not found" };
    if (!input.enabled) {
      await db
        .delete(collectionShareLinks)
        .where(eq(collectionShareLinks.collectionId, collection.id));
      return { token: null };
    }
    if (!canActAsOwner(session.user, collection.userId)) {
      return { error: "Only the owner can create a public link" };
    }
    const [row] = await db
      .insert(collectionShareLinks)
      .values({
        collectionId: collection.id,
        token: generateShareToken(),
        createdBy: session.user.id,
      })
      .onConflictDoUpdate({
        target: collectionShareLinks.collectionId,
        set: { collectionId: collection.id },
      })
      .returning({ token: collectionShareLinks.token });
    return { token: row.token };
  }

  return { error: "Invalid share target" };
}
