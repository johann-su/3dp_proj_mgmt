// DB-backed helpers around category suggestion (the pure logic lives in
// src/lib/category-suggest.ts). Every model should end up with a category —
// "Other" at worst — so both helpers only return null on an unseeded database
// (categories.category_id stays nullable for exactly that case).

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { categories } from "@/db/schema";
import { OTHER_CATEGORY_SLUG } from "@/lib/category-defaults";
import { suggestCategory, type CategorySignals } from "@/lib/category-suggest";

export async function otherCategoryId(): Promise<string | null> {
  const other = await db.query.categories.findFirst({
    where: eq(categories.slug, OTHER_CATEGORY_SLUG),
    columns: { id: true },
  });
  return other?.id ?? null;
}

// Suggests a category from title/tags/source-categories, falling back to
// "Other". Used where models are created without a form (collection import).
export async function pickCategoryId(
  signals: CategorySignals,
): Promise<string | null> {
  const all = await db.query.categories.findMany();
  return (
    suggestCategory(all, signals) ??
    all.find((c) => c.slug === OTHER_CATEGORY_SLUG)?.id ??
    null
  );
}
