"use client";

import { Loader2 } from "lucide-react";
import { loadMoreFeed } from "@/app/actions";
import { ModelCard } from "@/components/model-card";
import { CollectionCard } from "@/components/collection-card";
import type { FeedItem } from "@/lib/list-queries";
import { useInfiniteScroll } from "@/hooks/use-infinite-scroll";

// Continuous homepage feed mixing model and collection cards, ordered by
// recency and loaded via endless scroll.
export function FeedGrid({
  initialItems,
  initialCursor,
  category,
}: {
  initialItems: FeedItem[];
  initialCursor: string | null;
  category?: string;
}) {
  const { items, hasMore, error, sentinelRef, loadMore } = useInfiniteScroll(
    initialItems,
    initialCursor,
    (cursor) => loadMoreFeed({ category, cursor }),
  );

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {items.map((item) =>
          item.type === "model" ? (
            <ModelCard key={`m-${item.id}`} model={item.model} />
          ) : (
            <CollectionCard key={`c-${item.id}`} collection={item.collection} />
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
