import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { after } from "next/server";
import { eq } from "drizzle-orm";
import { ExternalLink, FolderOpen, Sparkles, SquarePen } from "lucide-react";
import { db } from "@/db";
import { collections } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { fileSrc } from "@/lib/file-token";
import { formatDate } from "@/lib/format";
import { incrementCollectionViewCount } from "@/lib/metrics";
import { platformFromSourceUrl, platformLabels } from "@/lib/platform";
import { smartCollectionModelCards } from "@/lib/smart-collections";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ModelCard, type ModelCardData } from "@/components/model-card";
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

  after(() => incrementCollectionViewCount(collection.id));

  const isOwner = session.user.id === collection.userId;
  const sourcePlatform = platformFromSourceUrl(collection.sourceUrl);
  const isSmart = collection.smart && collection.rules != null;

  // Smart collections evaluate their rule tree live (nothing is stored in
  // collection_models); manual ones render their hand-picked rows.
  const modelCards: ModelCardData[] = isSmart
    ? await smartCollectionModelCards(collection.rules)
    : collection.collectionModels.map(({ model }) => ({
        ...model,
        files: model.files.map((f) => ({
          id: f.id,
          src: fileSrc(f.id),
          animated: f.animated,
        })),
      }));

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-3xl font-bold tracking-tight">
              {collection.title}
            </h1>
            {isSmart && (
              <Badge
                className="gap-1"
                title="Membership is defined by rules and updates automatically"
              >
                <Sparkles className="size-3" />
                Smart
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground">
            by {collection.user.name} · {formatDate(collection.createdAt)} ·{" "}
            {modelCards.length} model
            {modelCards.length === 1 ? "" : "s"}
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

      {modelCards.length === 0 ? (
        <div className="text-center py-24 text-muted-foreground">
          <FolderOpen className="size-10 mx-auto mb-3 opacity-50" />
          <p>
            {isSmart
              ? "No models match this collection's rules yet."
              : "No models in this collection yet."}
            {isOwner &&
              (isSmart
                ? " Edit the collection to adjust its rules."
                : " Use “Add to collection” on a model page to add some.")}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {modelCards.map((model) => (
            <ModelCard key={model.id} model={model} />
          ))}
        </div>
      )}
    </div>
  );
}
