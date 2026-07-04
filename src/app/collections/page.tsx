import Link from "next/link";
import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { FolderOpen } from "lucide-react";
import { db } from "@/db";
import { collections } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function MyCollectionsPage() {
  const session = await getSession();
  if (!session) redirect("/sign-in");

  const results = await db.query.collections.findMany({
    where: eq(collections.userId, session.user.id),
    orderBy: desc(collections.createdAt),
    with: {
      collectionModels: {
        with: {
          model: {
            columns: { id: true },
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

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight mb-1">My Collections</h1>
        <p className="text-muted-foreground">
          {results.length} collection{results.length === 1 ? "" : "s"}.
        </p>
      </div>

      {results.length === 0 ? (
        <div className="text-center py-24 text-muted-foreground">
          <FolderOpen className="size-10 mx-auto mb-3 opacity-50" />
          <p>
            No collections yet.{" "}
            <Link href="/collections/new" className="underline">
              Create one!
            </Link>
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {results.map((collection) => {
            const cover = collection.collectionModels
              .map((cm) => cm.model.files[0])
              .find(Boolean);
            return (
              <Link
                key={collection.id}
                href={`/collections/${collection.id}`}
                className="group"
              >
                <Card className="overflow-hidden h-full py-0 gap-0 transition-shadow group-hover:shadow-md">
                  <div className="aspect-[4/3] bg-muted flex items-center justify-center overflow-hidden">
                    {cover ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`/api/files/${cover.id}`}
                        alt={collection.title}
                        className="w-full h-full object-cover transition-transform group-hover:scale-105"
                      />
                    ) : (
                      <FolderOpen className="size-10 text-muted-foreground/50" />
                    )}
                  </div>
                  <CardContent className="p-3">
                    <div className="font-medium truncate">{collection.title}</div>
                    <div className="text-sm text-muted-foreground">
                      {collection.collectionModels.length} model
                      {collection.collectionModels.length === 1 ? "" : "s"}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
