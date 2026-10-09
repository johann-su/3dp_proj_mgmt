import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { FolderOpen } from "lucide-react";
import { db } from "@/db";
import { collections } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { GALLERY_KINDS } from "@/lib/file-kind";
import { formatDate } from "@/lib/format";
import { resolveShareLink } from "@/lib/share-links";
import { sharedFileSrc, sharedModelPath } from "@/lib/share-token";
import { smartCollectionModelCards } from "@/lib/smart-collections";
import { ModelCard, type ModelCardData } from "@/components/model-card";
import { Markdown } from "@/components/markdown";
import { ModelView } from "@/app/models/model-view";
import { ShareBanner } from "./share-banner";
import { loadSharedModelView } from "./shared-model";

export const dynamic = "force-dynamic";

// Share links are bearer URLs: keep them out of search indexes even if one
// gets posted somewhere a crawler can see.
export const metadata: Metadata = {
  title: "Shared on Print Vault",
  robots: { index: false, follow: false },
};

// Public view of a shared model or collection — the one page tree reachable
// without a session (proxy.ts lets /share through). The token is the only
// credential; an unknown, revoked or disabled link is a plain 404, never a
// sign-in redirect, so the response doesn't reveal whether it ever existed.
export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const [share, session] = await Promise.all([resolveShareLink(token), getSession()]);
  if (!share) notFound();

  if (share.kind === "model") {
    const data = await loadSharedModelView(share.token, share.modelId);
    if (!data) notFound();
    return (
      <div className="mx-auto max-w-6xl px-4 py-8">
        <ShareBanner signedIn={!!session} catalogHref={`/models/${share.modelId}`} />
        <ModelView data={data} />
      </div>
    );
  }

  const collection = await db.query.collections.findFirst({
    where: eq(collections.id, share.collectionId),
    with: {
      user: { columns: { name: true } },
      collectionModels: {
        orderBy: (cm, { desc }) => desc(cm.addedAt),
        with: {
          model: {
            with: {
              user: { columns: { name: true } },
              category: true,
              files: {
                where: (f, { inArray }) => inArray(f.kind, GALLERY_KINDS),
                orderBy: (f, { asc }) => asc(f.position),
                limit: 1,
              },
              modelTags: { with: { tag: true } },
            },
          },
        },
      },
    },
  });
  if (!collection) notFound();

  // Same membership as the member page (live rules for smart collections,
  // trashed members hidden), but covers re-pointed at share-scoped URLs so
  // they stop loading the moment the link is revoked.
  const sharedCover = (f: { id: string; animated?: boolean; kind?: string }) => ({
    id: f.id,
    src: sharedFileSrc(share.token, f.id),
    animated: f.animated,
    kind: f.kind,
  });
  const modelCards: ModelCardData[] = share.smart
    ? (await smartCollectionModelCards(share.rules)).map((model) => ({
        ...model,
        files: model.files.map(sharedCover),
      }))
    : collection.collectionModels
        .filter(({ model }) => model.deletedAt === null)
        .map(({ model }) => ({ ...model, files: model.files.map(sharedCover) }));

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <ShareBanner signedIn={!!session} catalogHref={`/collections/${collection.id}`} />
      <div className="mb-8">
        <h1 className="mb-1 text-3xl font-bold tracking-tight">{collection.title}</h1>
        <p className="text-muted-foreground">
          by {collection.user.name} · {formatDate(collection.createdAt)} ·{" "}
          {modelCards.length} model{modelCards.length === 1 ? "" : "s"}
        </p>
        {collection.description && (
          <Markdown className="mt-3 max-w-2xl">{collection.description}</Markdown>
        )}
      </div>

      {modelCards.length === 0 ? (
        <div className="py-24 text-center text-muted-foreground">
          <FolderOpen className="mx-auto mb-3 size-10 opacity-50" />
          <p>This collection is empty.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {modelCards.map((model) => (
            <ModelCard
              key={model.id}
              model={model}
              href={sharedModelPath(share.token, model.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
