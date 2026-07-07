"use server";

import { parseSearchParams } from "@/lib/search-params";
import { search, type SearchPage } from "@/lib/search";

// Fetches the next page of search results for endless scroll. The raw query
// params are echoed back from the client and re-parsed here, so the server is
// the single source of truth for how filters map onto the query.
export async function loadMoreSearch(input: {
  params: Record<string, string | string[] | undefined>;
  cursor: string;
}): Promise<SearchPage> {
  const filters = parseSearchParams(input.params);
  return search(filters, input.cursor);
}
