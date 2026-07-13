"use client";

import { useRouter } from "next/navigation";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { FeedSort } from "@/lib/feed-params";

const SORT_LABELS: Record<FeedSort, string> = {
  newest: "Newest",
  oldest: "Oldest",
  updated: "Recently updated",
  views: "Most viewed",
  downloads: "Most downloaded",
};

const SORT_OPTIONS = Object.keys(SORT_LABELS) as FeedSort[];

// Homepage sort control. Pushes ?sort= (and the active category, if any) so a
// server re-render seeds a fresh first page — the grid below remounts on the
// combined key to reset endless scroll.
export function FeedSort({ sort, category }: { sort: FeedSort; category?: string }) {
  const router = useRouter();

  function apply(next: FeedSort) {
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    if (next !== "newest") params.set("sort", next);
    const qs = params.toString();
    router.push(qs ? `/?${qs}` : "/");
  }

  return (
    <div className="flex items-center gap-2">
      <Label className="text-sm text-muted-foreground shrink-0">Sort by</Label>
      <Select value={sort} onValueChange={(v) => apply(v as FeedSort)}>
        <SelectTrigger className="w-[170px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SORT_OPTIONS.map((s) => (
            <SelectItem key={s} value={s}>
              {SORT_LABELS[s]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
