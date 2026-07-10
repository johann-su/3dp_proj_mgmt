"use server";

import { getSession } from "@/lib/auth";
import { parseSearchParams } from "@/lib/search-params";
import { search, type SearchPage } from "@/lib/search";

// Fetches the next page of search results for endless scroll. The raw query
// params are echoed back from the client and re-parsed here, so the server is
// the single source of truth for how filters map onto the query.
export async function loadMoreSearch(input: {
  params: Record<string, string | string[] | undefined>;
  cursor: string;
}): Promise<SearchPage> {
  // The catalog is private; an expired session just ends the endless scroll.
  const session = await getSession();
  if (!session) return { items: [], nextCursor: null };

  const filters = parseSearchParams(input.params);
  return search(filters, input.cursor);
}
