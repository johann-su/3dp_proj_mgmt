"use client";

import { Loader2 } from "lucide-react";
import { loadMoreModels } from "@/app/actions";
import { ModelCard, type ModelCardData } from "@/components/model-card";
import { useInfiniteScroll } from "@/hooks/use-infinite-scroll";

export function ModelGrid({
  initialItems,
  initialCursor,
  q,
  category,
}: {
  initialItems: ModelCardData[];
  initialCursor: string | null;
  q?: string;
  category?: string;
}) {
  const { items, hasMore, error, sentinelRef, loadMore } = useInfiniteScroll(
    initialItems,
    initialCursor,
    (cursor) => loadMoreModels({ q, category, cursor }),
  );

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {items.map((model) => (
          <ModelCard key={model.id} model={model} />
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
