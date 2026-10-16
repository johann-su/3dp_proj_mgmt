import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  collectionModels,
  collectionShareLinks,
  collections,
  modelShareLinks,
  models,
} from "@/db/schema";
import { smartCollectionContains } from "@/lib/smart-collections";
import { isWellFormedShareToken, publicSharingEnabled } from "@/lib/share-token";

// Public share links: the one surface where an anonymous visitor may read
// catalog content. Every public page and the shared file route resolve the
// token through here on *every* request, so a revoked link (row deleted) or
// DISABLE_PUBLIC_SHARING cuts access off immediately. See
// docs/architecture/auth-and-access.md#public-share-links.

export type ShareKind = "model" | "collection";

export type ResolvedShare =
  | { kind: "model"; token: string; modelId: string }
  | {
      kind: "collection";
      token: string;
      collectionId: string;
      smart: boolean;
      rules: unknown;
    };

// Token → what it shares, or null for a malformed/unknown/revoked token (or
// sharing disabled). A model share whose model sits in the trash resolves to
// null too: trashed models aren't viewable, and restoring brings the link back.
export async function resolveShareLink(
  token: string | null | undefined,
): Promise<ResolvedShare | null> {
  if (!publicSharingEnabled() || !isWellFormedShareToken(token)) return null;

  const [modelLink] = await db
    .select({ modelId: modelShareLinks.modelId })
    .from(modelShareLinks)
    .innerJoin(models, eq(models.id, modelShareLinks.modelId))
    .where(and(eq(modelShareLinks.token, token), isNull(models.deletedAt)))
    .limit(1);
  if (modelLink) return { kind: "model", token, modelId: modelLink.modelId };

  const [collectionLink] = await db
    .select({
      collectionId: collections.id,
      smart: collections.smart,
      rules: collections.rules,
    })
    .from(collectionShareLinks)
    .innerJoin(collections, eq(collections.id, collectionShareLinks.collectionId))
    .where(eq(collectionShareLinks.token, token))
    .limit(1);
  if (collectionLink) {
    return {
      kind: "collection",
      token,
      collectionId: collectionLink.collectionId,
      smart: collectionLink.smart && collectionLink.rules != null,
      rules: collectionLink.rules,
    };
  }
  return null;
}

// Whether a resolved share lets its holder see a given model: the shared model
// itself, or a current, non-trashed member of the shared collection (live
// rules for smart collections). Removing a model from the collection revokes
// access to it through that link.
export async function shareGrantsModel(
  share: ResolvedShare,
  modelId: string,
): Promise<boolean> {
  if (share.kind === "model") return share.modelId === modelId;
  if (share.smart) return smartCollectionContains(share.rules, modelId);
  const [row] = await db
    .select({ modelId: collectionModels.modelId })
    .from(collectionModels)
    .innerJoin(models, eq(models.id, collectionModels.modelId))
    .where(
      and(
        eq(collectionModels.collectionId, share.collectionId),
        eq(collectionModels.modelId, modelId),
        isNull(models.deletedAt),
      ),
    )
    .limit(1);
  return !!row;
}

// The live token for an item, for the share dialog (null = private).
export async function getShareToken(
  kind: ShareKind,
  id: string,
): Promise<string | null> {
  const row =
    kind === "model"
      ? await db.query.modelShareLinks.findFirst({
          where: (l, { eq }) => eq(l.modelId, id),
          columns: { token: true },
        })
      : await db.query.collectionShareLinks.findFirst({
          where: (l, { eq }) => eq(l.collectionId, id),
          columns: { token: true },
        });
  return row?.token ?? null;
}
