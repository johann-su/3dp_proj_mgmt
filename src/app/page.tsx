import Link from "next/link";
import { redirect } from "next/navigation";
import { desc } from "drizzle-orm";
import { Box, Search } from "lucide-react";
import { db } from "@/db";
import { collections } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { fileSrc } from "@/lib/file-token";
import { listModels } from "@/lib/list-queries";
import { ModelGrid } from "@/components/model-grid";
import { CollectionCard } from "@/components/collection-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const dynamic = "force-dynamic";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  // The whole catalog is private — self-hosted instances store paid models.
  const session = await getSession();
  if (!session) redirect("/sign-in");

  const { category } = await searchParams;

  const allCategories = await db.query.categories.findMany({
    orderBy: (c, { asc }) => asc(c.name),
  });
  const activeCategory = allCategories.find((c) => c.slug === category);

  const recentCollections = await db.query.collections.findMany({
    orderBy: desc(collections.createdAt),
    limit: 8,
    with: {
      user: { columns: { name: true } },
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

  const recentCollectionCards = recentCollections.map((c) => ({
    id: c.id,
    title: c.title,
    user: c.user,
    collectionModels: c.collectionModels.map((cm) => ({
      model: {
        id: cm.model.id,
        files: cm.model.files.map((f) => ({ id: f.id, src: fileSrc(f.id) })),
      },
    })),
  }));

  const { items: models, nextCursor } = await listModels({
    categoryId: activeCategory?.id,
  });

  function categoryHref(slug?: string) {
    const params = new URLSearchParams();
    if (slug) params.set("category", slug);
    const qs = params.toString();
    return qs ? `/?${qs}` : "/";
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight mb-1">Models</h1>
        <p className="text-muted-foreground">
          Browse, search and download 3D printing models.
        </p>
      </div>

      <form action="/search" className="flex gap-2 mb-4 max-w-md">
        <Input
          type="search"
          name="q"
          placeholder="Search models and collections…"
        />
        <Button type="submit" variant="secondary" aria-label="Search">
          <Search className="size-4" />
        </Button>
      </form>

      <div className="flex flex-wrap gap-2 mb-8">
        <Link href={categoryHref()}>
          <Badge variant={activeCategory ? "outline" : "default"}>All</Badge>
        </Link>
        {allCategories.map((c) => (
          <Link key={c.id} href={categoryHref(c.slug)}>
            <Badge variant={activeCategory?.id === c.id ? "default" : "outline"}>
              {c.name}
            </Badge>
          </Link>
        ))}
      </div>

      {recentCollectionCards.length > 0 && (
        <div className="mb-10">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold tracking-tight">Collections</h2>
            <Link
              href="/collections"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              See all
            </Link>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {recentCollectionCards.map((collection) => (
              <CollectionCard key={collection.id} collection={collection} />
            ))}
          </div>
        </div>
      )}

      <div className="mb-4">
        <h2 className="text-xl font-semibold tracking-tight">Models</h2>
      </div>

      {models.length === 0 ? (
        <div className="text-center py-24 text-muted-foreground">
          <Box className="size-10 mx-auto mb-3 opacity-50" />
          {activeCategory ? (
            <p>No models in this category yet.</p>
          ) : (
            <p>
              No models yet.{" "}
              <Link href="/models/new" className="underline">
                Upload the first one!
              </Link>
            </p>
          )}
        </div>
      ) : (
        <ModelGrid
          key={category ?? ""}
          initialItems={models}
          initialCursor={nextCursor}
          category={category}
        />
      )}
    </div>
  );
}
