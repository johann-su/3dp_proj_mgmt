"use client";

import { Loader2 } from "lucide-react";
import { loadMoreCollections } from "@/app/collections/actions";
import {
  MyCollectionCard,
  type MyCollectionData,
} from "@/components/my-collection-card";
import { useInfiniteScroll } from "@/hooks/use-infinite-scroll";

export function CollectionGrid({
  initialItems,
  initialCursor,
}: {
  initialItems: MyCollectionData[];
  initialCursor: string | null;
}) {
  const { items, hasMore, error, sentinelRef, loadMore } = useInfiniteScroll(
    initialItems,
    initialCursor,
    (cursor) => loadMoreCollections({ cursor }),
  );

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {items.map((collection) => (
          <MyCollectionCard key={collection.id} collection={collection} />
        ))}
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
