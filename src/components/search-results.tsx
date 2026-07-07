"use client";

import { Loader2 } from "lucide-react";
import { loadMoreSearch } from "@/app/search/actions";
import { ModelCard } from "@/components/model-card";
import { CollectionCard } from "@/components/collection-card";
import type { SearchItem } from "@/lib/search";
import { useInfiniteScroll } from "@/hooks/use-infinite-scroll";

function itemKey(item: SearchItem): string {
  return item.kind === "model" ? `m:${item.model.id}` : `c:${item.collection.id}`;
}

export function SearchResults({
  initialItems,
  initialCursor,
  params,
}: {
  initialItems: SearchItem[];
  initialCursor: string | null;
  // The flat query params for the current search, echoed to the load-more
  // action so paged results match the visible filters.
  params: Record<string, string | string[] | undefined>;
}) {
  const { items, hasMore, error, sentinelRef, loadMore } = useInfiniteScroll(
    initialItems,
    initialCursor,
    (cursor) => loadMoreSearch({ params, cursor }),
  );

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
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
