import Link from "next/link";
import { redirect } from "next/navigation";
import { Box, Search } from "lucide-react";
import { db } from "@/db";
import { getSession } from "@/lib/auth";
import { parseFeedSort } from "@/lib/feed-params";
import { listFeed } from "@/lib/list-queries";
import { FeedGrid } from "@/components/feed-grid";
import { FeedSort } from "@/components/feed-sort";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const dynamic = "force-dynamic";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; sort?: string }>;
}) {
  // The whole catalog is private — self-hosted instances store paid models.
  const session = await getSession();
  if (!session) redirect("/sign-in");

  const { category, sort: rawSort } = await searchParams;
  const sort = parseFeedSort(rawSort);

  const allCategories = await db.query.categories.findMany({
    orderBy: (c, { asc }) => asc(c.name),
  });
  const activeCategory = allCategories.find((c) => c.slug === category);

  const { items, nextCursor } = await listFeed({
    categoryId: activeCategory?.id,
    sort,
  });

  function categoryHref(slug?: string) {
    const params = new URLSearchParams();
    if (slug) params.set("category", slug);
    if (sort !== "newest") params.set("sort", sort);
    const qs = params.toString();
    return qs ? `/?${qs}` : "/";
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight mb-1">Browse</h1>
        <p className="text-muted-foreground">
          Browse, search and download 3D printing models and collections.
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

      <div className="flex flex-wrap items-center justify-between gap-4 mb-8">
        <div className="flex flex-wrap gap-2">
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
        <FeedSort sort={sort} category={category} />
      </div>

      {items.length === 0 ? (
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
        <FeedGrid
          key={`${category ?? ""}:${sort}`}
          initialItems={items}
          initialCursor={nextCursor}
          category={category}
          sort={sort}
        />
      )}
    </div>
  );
}
