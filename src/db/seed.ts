import { db } from "./index";
import { categories } from "./schema";

const defaults = [
  "Art",
  "Fashion",
  "Functional",
  "Gadgets",
  "Games & Toys",
  "Household",
  "Miniatures",
  "Tools",
  "Other",
];

async function seed() {
  await db
    .insert(categories)
    .values(
      defaults.map((name) => ({
        name,
        slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      })),
    )
    .onConflictDoNothing();
  console.log("Seeded categories");
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
