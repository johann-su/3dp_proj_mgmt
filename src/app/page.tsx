import Link from "next/link";
import { redirect } from "next/navigation";
import { Box } from "lucide-react";
import { db } from "@/db";
import { getSession, signInRedirect } from "@/lib/auth";
import { parseFeedSort } from "@/lib/feed-params";
import { listFeed } from "@/lib/list-queries";
import { FeedGrid } from "@/components/feed-grid";
import { FeedSort } from "@/components/feed-sort";
import { SearchBar } from "@/components/search-bar";

export const dynamic = "force-dynamic";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; sort?: string }>;
}) {
  // The whole catalog is private — self-hosted instances store paid models.
  const session = await getSession();
  if (!session) redirect(await signInRedirect());

  const { category, sort: rawSort } = await searchParams;
  const sort = parseFeedSort(rawSort);

  // No category picker on the homepage itself — this only serves deep links
  // from a model's category badge (see model-view.tsx), which still filters.
  const activeCategory = category
    ? await db.query.categories.findFirst({
        where: (c, { eq }) => eq(c.slug, category),
      })
    : undefined;

  const { items, nextCursor } = await listFeed({
    categoryId: activeCategory?.id,
    sort,
  });

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight mb-1">Browse</h1>
        <p className="text-muted-foreground">
          Browse, search and download 3D printing models and collections.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 mb-8">
        <SearchBar />
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
