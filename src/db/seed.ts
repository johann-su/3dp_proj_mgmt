import { sql } from "drizzle-orm";
import { db } from "./index";
import { categories } from "./schema";
import { DEFAULT_CATEGORIES } from "@/lib/category-defaults";

async function seed() {
  await db
    .insert(categories)
    .values(
      DEFAULT_CATEGORIES.map(({ name, slug, keywords }) => ({
        name,
        slug,
        keywords,
      })),
    )
    // Keywords follow the shipped defaults on re-seed; names stay untouched.
    .onConflictDoUpdate({
      target: categories.slug,
      set: { keywords: sql`excluded.keywords` },
    });
  console.log("Seeded categories");
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
