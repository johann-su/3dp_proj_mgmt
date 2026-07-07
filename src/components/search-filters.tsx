"use client";

import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PRINT_TIME_BUCKETS,
  hasModelOnlyFilter,
  searchFiltersToQueryString,
  type SearchFilters,
  type SearchSort,
  type SearchType,
} from "@/lib/search-params";
import type { SearchFacets } from "@/lib/search";

const ANY = "any";

// Radix Select can't hold an empty-string value, so "Any" is a sentinel that
// maps back to `undefined` (no filter).
function fromAny(v: string): string | undefined {
  return v === ANY ? undefined : v;
}

export function SearchFilters({
  filters,
  facets,
}: {
  filters: SearchFilters;
  facets: SearchFacets;
}) {
  const router = useRouter();

  function apply(patch: Partial<SearchFilters>) {
    const qs = searchFiltersToQueryString({ ...filters, ...patch });
    router.push(qs ? `/search?${qs}` : "/search");
  }

  function toggleFilament(fil: string) {
    const next = filters.filaments.includes(fil)
      ? filters.filaments.filter((f) => f !== fil)
      : [...filters.filaments, fil];
    apply({ filaments: next });
  }

  const showModelFilters = filters.type !== "collections";
  const anyActive =
    filters.type !== "all" ||
    filters.userId !== undefined ||
    hasModelOnlyFilter(filters);

  return (
    <div className="space-y-5 text-sm">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Filters</h2>
        {anyActive && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-muted-foreground"
            onClick={() =>
              apply({
                type: "all",
                userId: undefined,
                printer: undefined,
                filaments: [],
                nozzle: undefined,
                maxPrintTime: undefined,
              })
            }
          >
            <X className="size-3.5" /> Clear
          </Button>
        )}
      </div>

      <div className="space-y-1.5">
        <Label>Sort by</Label>
        <Select value={filters.sort} onValueChange={(v) => apply({ sort: v as SearchSort })}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="relevance">Relevance</SelectItem>
            <SelectItem value="newest">Newest</SelectItem>
            <SelectItem value="oldest">Oldest</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label>Type</Label>
        <Select value={filters.type} onValueChange={(v) => apply({ type: v as SearchType })}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Models &amp; collections</SelectItem>
            <SelectItem value="models">Models only</SelectItem>
            <SelectItem value="collections">Collections only</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {facets.users.length > 0 && (
        <div className="space-y-1.5">
          <Label>Uploaded by</Label>
          <Select
            value={filters.userId ?? ANY}
            onValueChange={(v) => apply({ userId: fromAny(v) })}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Anyone" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Anyone</SelectItem>
              {facets.users.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {showModelFilters && (
        <>
          <Separator />

          {facets.printers.length > 0 && (
            <div className="space-y-1.5">
              <Label>Printer</Label>
              <Select
                value={filters.printer ?? ANY}
                onValueChange={(v) => apply({ printer: fromAny(v) })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Any printer" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any printer</SelectItem>
                  {facets.printers.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {facets.nozzles.length > 0 && (
            <div className="space-y-1.5">
              <Label>Nozzle</Label>
              <Select
                value={filters.nozzle !== undefined ? String(filters.nozzle) : ANY}
                onValueChange={(v) =>
                  apply({ nozzle: v === ANY ? undefined : Number(v) })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Any nozzle" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any nozzle</SelectItem>
                  {facets.nozzles.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n} mm
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Print time</Label>
            <Select
              value={filters.maxPrintTime !== undefined ? String(filters.maxPrintTime) : ANY}
              onValueChange={(v) =>
                apply({ maxPrintTime: v === ANY ? undefined : Number(v) })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Any duration" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any duration</SelectItem>
                {PRINT_TIME_BUCKETS.map((b) => (
                  <SelectItem key={b.maxSeconds} value={String(b.maxSeconds)}>
                    {b.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {facets.filaments.length > 0 && (
            <div className="space-y-2">
              <Label>Filament</Label>
              <div className="flex flex-wrap gap-1.5">
                {facets.filaments.map((fil) => {
                  const active = filters.filaments.includes(fil);
                  return (
                    <button key={fil} type="button" onClick={() => toggleFilament(fil)}>
                      <Badge variant={active ? "default" : "outline"}>{fil}</Badge>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
