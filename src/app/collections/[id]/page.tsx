import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { ExternalLink, FolderOpen, SquarePen } from "lucide-react";
import { db } from "@/db";
import { collections } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { fileSrc } from "@/lib/file-token";
import { formatDate } from "@/lib/format";
import { platformFromSourceUrl, platformLabels } from "@/lib/platform";
import { Button } from "@/components/ui/button";
import { ModelCard } from "@/components/model-card";
import { CollectionSyncButton } from "./collection-sync-button";
import { DeleteCollectionButton } from "./delete-collection-button";

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function CollectionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const [collection, session] = await Promise.all([
    db.query.collections.findFirst({
      where: eq(collections.id, id),
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
                  where: (f, { eq }) => eq(f.kind, "image"),
                  orderBy: (f, { asc }) => asc(f.position),
                  limit: 1,
                },
                modelTags: { with: { tag: true } },
              },
            },
          },
        },
      },
    }),
    getSession(),
  ]);
  // The whole catalog is private — self-hosted instances store paid models.
  if (!session) redirect("/sign-in");
  if (!collection) notFound();

  const isOwner = session.user.id === collection.userId;
  const sourcePlatform = platformFromSourceUrl(collection.sourceUrl);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight mb-1">
            {collection.title}
          </h1>
          <p className="text-muted-foreground">
            by {collection.user.name} · {formatDate(collection.createdAt)} ·{" "}
            {collection.collectionModels.length} model
            {collection.collectionModels.length === 1 ? "" : "s"}
          </p>
          {collection.sourceUrl && sourcePlatform && (
            <a
              href={collection.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline mt-1"
            >
              <ExternalLink className="size-3.5" />
              Imported from {platformLabels[sourcePlatform]}
            </a>
          )}
          {collection.description && (
            <p className="mt-3 whitespace-pre-wrap text-sm max-w-2xl">
              {collection.description}
            </p>
          )}
        </div>
        {isOwner && (
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/collections/${collection.id}/edit`}>
                <SquarePen className="size-4" />
                Edit
              </Link>
            </Button>
            {collection.sourceUrl && (
              <CollectionSyncButton collectionId={collection.id} />
            )}
            <DeleteCollectionButton collectionId={collection.id} />
          </div>
        )}
      </div>

      {collection.collectionModels.length === 0 ? (
        <div className="text-center py-24 text-muted-foreground">
          <FolderOpen className="size-10 mx-auto mb-3 opacity-50" />
          <p>
            No models in this collection yet.
            {isOwner &&
              " Use “Add to collection” on a model page to add some."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {collection.collectionModels.map(({ model }) => (
            <ModelCard
              key={model.id}
              model={{
                ...model,
                files: model.files.map((f) => ({
                  id: f.id,
                  src: fileSrc(f.id),
                  animated: f.animated,
                })),
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
