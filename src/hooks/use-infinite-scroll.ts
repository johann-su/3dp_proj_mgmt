"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import type { Page } from "@/lib/pagination";

// Drives endless (cursor-based) scrolling for a list. `loadMore` is a closure
// over a server action; it takes the current cursor and resolves the next
// page. Attach `sentinelRef` to an element below the list — when it scrolls
// into view the next page is fetched and appended.
export function useInfiniteScroll<T>(
  initialItems: T[],
  initialCursor: string | null,
  loadMore: (cursor: string) => Promise<Page<T>>,
) {
  // Callers give this component a `key` tied to the query (search/filter), so a
  // fresh first page remounts it and these initial values seed a clean slate —
  // no in-effect resync, and any in-flight load from the previous query is torn
  // down with the old instance.
  const [items, setItems] = useState(initialItems);
  const [cursor, setCursor] = useState(initialCursor);
  const [error, setError] = useState(false);
  const [isPending, startTransition] = useTransition();
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // Guards against overlapping loads: the observer can fire again before the
  // transition flips isPending, which would fetch the same cursor twice.
  const loadingRef = useRef(false);

  const load = useCallback(() => {
    if (loadingRef.current || cursor === null) return;
    loadingRef.current = true;
    setError(false);
    startTransition(async () => {
      try {
        const page = await loadMore(cursor);
        setItems((prev) => [...prev, ...page.items]);
        setCursor(page.nextCursor);
      } catch {
        setError(true);
      } finally {
        loadingRef.current = false;
      }
    });
  }, [cursor, loadMore]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || cursor === null) return;
    // Preload before the sentinel is actually visible so scrolling stays smooth.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) load();
      },
      { rootMargin: "400px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [load, cursor]);

  return {
    items,
    hasMore: cursor !== null,
    isPending,
    error,
    sentinelRef,
    loadMore: load,
  };
}
