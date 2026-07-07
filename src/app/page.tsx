import Link from "next/link";
import { desc } from "drizzle-orm";
import { Box, Search } from "lucide-react";
import { db } from "@/db";
import { collections } from "@/db/schema";
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
  searchParams: Promise<{ q?: string; category?: string }>;
}) {
  const { q, category } = await searchParams;

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

  const { items: models, nextCursor } = await listModels({
    q,
    categoryId: activeCategory?.id,
  });

  function categoryHref(slug?: string) {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
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

      <form action="/" className="flex gap-2 mb-4 max-w-md">
        {activeCategory && (
          <input type="hidden" name="category" value={activeCategory.slug} />
        )}
        <Input
          type="search"
          name="q"
          defaultValue={q ?? ""}
          placeholder="Search models…"
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

      {recentCollections.length > 0 && (
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
            {recentCollections.map((collection) => (
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
          {q || activeCategory ? (
            <p>No models match your search.</p>
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
          key={`${q ?? ""}::${category ?? ""}`}
          initialItems={models}
          initialCursor={nextCursor}
          q={q}
          category={category}
        />
      )}
    </div>
  );
}
