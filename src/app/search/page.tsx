import Link from "next/link";
import { redirect } from "next/navigation";
import { Search, SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SearchFilters } from "@/components/search-filters";
import { SearchResults } from "@/components/search-results";
import { getSession, signInRedirect } from "@/lib/auth";
import { search, searchFacets } from "@/lib/search";
import { parseSearchParams, searchFiltersToParams } from "@/lib/search-params";

export const dynamic = "force-dynamic";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The whole catalog is private — self-hosted instances store paid models.
  const session = await getSession();
  if (!session) redirect(await signInRedirect());

  const params = await searchParams;
  const filters = parseSearchParams(params);

  const [{ items, nextCursor }, facets] = await Promise.all([
    search(filters),
    searchFacets(),
  ]);

  // Hidden inputs carry the active filters through the search-box GET submit so
  // refining the query term doesn't drop the sidebar selections.
  const carried = searchFiltersToParams(filters);
  delete carried.q;

  // Remount the results list whenever the query/filters change so infinite
  // scroll seeds a clean first page.
  const resultsKey = new URLSearchParams(
    Object.entries(carried).flatMap(([k, v]) =>
      Array.isArray(v) ? v.map((x) => [k, x] as [string, string]) : [[k, v] as [string, string]],
    ),
  );
  resultsKey.set("q", filters.q);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight mb-1">Search</h1>
        <p className="text-muted-foreground">
          Find models and collections across the catalog.
        </p>
      </div>

      <form action="/search" className="flex gap-2 mb-8 max-w-xl">
        {Object.entries(carried).flatMap(([k, v]) =>
          (Array.isArray(v) ? v : [v]).map((val, i) => (
            <input key={`${k}-${i}`} type="hidden" name={k} value={val} />
          )),
        )}
        <Input
          type="search"
          name="q"
          defaultValue={filters.q}
          placeholder="Search models and collections…"
          autoFocus
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="submit" variant="secondary" aria-label="Search">
              <Search className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Search</TooltipContent>
        </Tooltip>
      </form>

      <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-8">
        <aside className="md:sticky md:top-6 md:self-start">
          <SearchFilters filters={filters} facets={facets} />
        </aside>

        <div className="min-w-0">
          {items.length === 0 ? (
            <div className="text-center py-24 text-muted-foreground">
              <SearchX className="size-10 mx-auto mb-3 opacity-50" />
              <p>No results match your search.</p>
              <p className="mt-1 text-sm">
                Try a different term or{" "}
                <Link href="/search" className="underline">
                  clear the filters
                </Link>
                .
              </p>
            </div>
          ) : (
            <SearchResults
              key={resultsKey.toString()}
              initialItems={items}
              initialCursor={nextCursor}
              params={params}
            />
          )}
        </div>
      </div>
    </div>
  );
}
