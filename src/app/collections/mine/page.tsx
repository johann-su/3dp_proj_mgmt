import Link from "next/link";
import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { FolderOpen } from "lucide-react";
import { db } from "@/db";
import { collections } from "@/db/schema";
import { getSession, signInRedirect } from "@/lib/auth";
import { fileSrc } from "@/lib/file-token";
import { smartCollectionPreviews } from "@/lib/smart-collections";
import { CollectionCard, type CollectionCardData } from "@/components/collection-card";

export const dynamic = "force-dynamic";

export default async function MyCollectionsPage() {
  const session = await getSession();
  if (!session) redirect(await signInRedirect());

  const results = await db.query.collections.findMany({
    where: eq(collections.userId, session.user.id),
    orderBy: desc(collections.createdAt),
    with: {
      user: { columns: { name: true } },
      collectionModels: {
        with: {
          model: {
            columns: { id: true, deletedAt: true },
            with: {
              files: {
                where: (f, { eq }) => eq(f.kind, "image"),
                orderBy: (f, { asc }) => asc(f.position),
                limit: 1,
              },
            },
          },
        },
      },
    },
  });

  // Smart collections have no collection_models rows — their covers and count
  // come from evaluating the stored rules (see smart-collections.ts).
  const smartPreviews = await smartCollectionPreviews(
    results.filter((c) => c.smart).map((c) => ({ id: c.id, rules: c.rules })),
  );

  const cards: CollectionCardData[] = results.map((c) => {
    const preview = smartPreviews.get(c.id);
    return {
      id: c.id,
      title: c.title,
      user: c.user,
      smart: c.smart,
      totalModels: preview?.totalModels,
      collectionModels:
        preview?.collectionModels ??
        c.collectionModels
          // Trashed members stay linked but must not surface as covers.
          .filter((cm) => cm.model.deletedAt === null)
          .map((cm) => ({
            model: {
              id: cm.model.id,
              files: cm.model.files.map((f) => ({
                id: f.id,
                src: fileSrc(f.id),
                animated: f.animated,
              })),
            },
          })),
    };
  });

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight mb-1">My Collections</h1>
        <p className="text-muted-foreground">
          {cards.length} collection{cards.length === 1 ? "" : "s"} you created.
        </p>
      </div>

      {cards.length === 0 ? (
        <div className="text-center py-24 text-muted-foreground">
          <FolderOpen className="size-10 mx-auto mb-3 opacity-50" />
          <p>
            You haven&apos;t created any collections yet.{" "}
            <Link href="/collections/new" className="underline">
              Create one!
            </Link>
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {cards.map((collection) => (
            <CollectionCard key={collection.id} collection={collection} />
          ))}
        </div>
      )}
    </div>
  );
}
