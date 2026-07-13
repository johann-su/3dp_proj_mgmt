"use client";

import { Loader2 } from "lucide-react";
import { loadMoreFeed } from "@/app/actions";
import { ModelCard } from "@/components/model-card";
import { CollectionCard } from "@/components/collection-card";
import type { FeedItem } from "@/lib/list-queries";
import type { FeedSort } from "@/lib/feed-params";
import { useInfiniteScroll } from "@/hooks/use-infinite-scroll";

function itemKey(item: FeedItem): string {
  return item.kind === "model" ? `m:${item.model.id}` : `c:${item.collection.id}`;
}

// Continuous homepage feed mixing model and collection cards, ordered by the
// active sort and loaded via endless scroll.
export function FeedGrid({
  initialItems,
  initialCursor,
  category,
  sort,
}: {
  initialItems: FeedItem[];
  initialCursor: string | null;
  category?: string;
  sort?: FeedSort;
}) {
  const { items, hasMore, error, sentinelRef, loadMore } = useInfiniteScroll(
    initialItems,
    initialCursor,
    (cursor) => loadMoreFeed({ category, sort, cursor }),
  );

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {items.map((item) =>
          item.kind === "model" ? (
            <ModelCard key={itemKey(item)} model={item.model} />
          ) : (
            <CollectionCard key={itemKey(item)} collection={item.collection} />
          ),
        )}
      </div>
      {hasMore && (
        <div ref={sentinelRef} className="flex justify-center py-8">
          {error ? (
            <button
              onClick={() => loadMore()}
              className="text-sm text-muted-foreground underline hover:text-foreground"
            >
              Failed to load more. Retry
            </button>
          ) : (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          )}
        </div>
      )}
    </>
  );
}
