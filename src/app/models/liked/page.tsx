import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { Heart } from "lucide-react";
import { db } from "@/db";
import { modelLikes, models } from "@/db/schema";
import { getSession, signInRedirect } from "@/lib/auth";
import { fileSrc } from "@/lib/file-token";
import { parametricExtra } from "@/lib/parametric";
import { ModelCard } from "@/components/model-card";

export const dynamic = "force-dynamic";

export default async function LikedModelsPage() {
  const session = await getSession();
  if (!session) redirect(await signInRedirect());

  // Liked model ids, most recently liked first — this order is what the page
  // preserves, so we resolve it here rather than sorting the models by date.
  const likeRows = await db
    .select({ modelId: modelLikes.modelId })
    .from(modelLikes)
    .where(eq(modelLikes.userId, session.user.id))
    .orderBy(desc(modelLikes.createdAt));
  const likedIds = likeRows.map((r) => r.modelId);

  // Hydrate the cards with the same shape as My Models. Trashed models keep
  // their like row but are filtered out (deleted_at IS NULL), so the count can
  // be lower than the number of likes.
  const found = likedIds.length
    ? await db.query.models.findMany({
        where: and(inArray(models.id, likedIds), isNull(models.deletedAt)),
        extras: (m) => ({ parametric: parametricExtra(m.id) }),
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
      })
    : [];
  // findMany doesn't preserve the inArray order, so reindex by like order.
  const byId = new Map(found.map((m) => [m.id, m]));
  const results = likedIds
    .map((id) => byId.get(id))
    .filter((m): m is (typeof found)[number] => m !== undefined);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight mb-1">Liked Models</h1>
        <p className="text-muted-foreground">
          {results.length} model{results.length === 1 ? "" : "s"} you liked.
        </p>
      </div>

      {results.length === 0 ? (
        <div className="text-center py-24 text-muted-foreground">
          <Heart className="size-10 mx-auto mb-3 opacity-50" />
          <p>
            You haven&apos;t liked any models yet.{" "}
            <Link href="/" className="underline">
              Browse models
            </Link>{" "}
            and tap the like button to save them here.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {results.map((model) => (
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
