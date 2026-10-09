import Link from "next/link";
import { redirect } from "next/navigation";
import { Box, Pin } from "lucide-react";
import { db } from "@/db";
import { getSession, signInRedirect } from "@/lib/auth";
import { parseFeedSort } from "@/lib/feed-params";
import { listFeed } from "@/lib/list-queries";
import { listPinned } from "@/lib/pins";
import { CollectionCard } from "@/components/collection-card";
import { FeedGrid } from "@/components/feed-grid";
import { ModelCard } from "@/components/model-card";
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

  // Pins are shared across all users. They're a homepage shelf, so a
  // category deep link (a filtered view) shows just the filtered feed.
  const [{ items, nextCursor }, pinned] = await Promise.all([
    listFeed({ categoryId: activeCategory?.id, sort }),
    activeCategory ? Promise.resolve([]) : listPinned(),
  ]);

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

      {pinned.length > 0 && (
        <section className="mb-10" aria-labelledby="pinned-heading">
          <h2
            id="pinned-heading"
            className="mb-4 flex items-center gap-2 text-xl font-semibold tracking-tight"
          >
            <Pin className="size-5" />
            Pinned
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {pinned.map((item) =>
              item.kind === "model" ? (
                <ModelCard key={`m:${item.model.id}`} model={item.model} />
              ) : (
                <CollectionCard
                  key={`c:${item.collection.id}`}
                  collection={item.collection}
                />
              ),
            )}
          </div>
        </section>
      )}

      {pinned.length > 0 && (
        <h2 className="mb-4 text-xl font-semibold tracking-tight">
          All models &amp; collections
        </h2>
      )}

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
