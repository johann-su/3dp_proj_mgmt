"use server";

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { categories } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { listModels } from "@/lib/list-queries";
import type { ModelCardData } from "@/components/model-card";
import type { Page } from "@/lib/pagination";

// Fetches the next page of homepage models for endless scroll. Filters (search
// query, category slug) are echoed back from the client so the paged results
// match the currently displayed list.
export async function loadMoreModels(input: {
  q?: string;
  category?: string;
  cursor: string;
}): Promise<Page<ModelCardData>> {
  // The catalog is private; an expired session just ends the endless scroll.
  const session = await getSession();
  if (!session) return { items: [], nextCursor: null };

  let categoryId: string | undefined;
  if (input.category) {
    const category = await db.query.categories.findFirst({
      where: eq(categories.slug, input.category),
      columns: { id: true },
    });
    // Unknown slug → no category filter, matching the homepage's "All" behavior.
    categoryId = category?.id;
  }

  return listModels({ q: input.q, categoryId, cursor: input.cursor });
}
