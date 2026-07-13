import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestCategory, type SuggestableCategory } from "@/lib/category-suggest";
import { DEFAULT_CATEGORIES } from "@/lib/category-defaults";

// Tests run against the shipped default keyword lists — they double as a check
// that the seeded taxonomy actually routes common MakerWorld categories.
const categories: SuggestableCategory[] = DEFAULT_CATEGORIES.map((c) => ({
  id: c.slug, // stand-in for the DB uuid; suggestCategory only echoes it back
  name: c.name,
  keywords: c.keywords,
}));

test("MakerWorld source categories map onto an existing category", () => {
  // MakerWorld lists leaf + parent ("Signs & Logos", "Art") — both should
  // reinforce the same local category.
  assert.equal(
    suggestCategory(categories, { sourceCategories: ["Signs & Logos", "Art"] }),
    "art",
  );
});

test("source category outranks a conflicting title word", () => {
  // The platform's own classification is the strongest indicator: a "Dragon
  // Tool Holder" filed under Miniatures stays Miniatures despite "tool" and
  // "holder" in the title.
  assert.equal(
    suggestCategory(categories, {
      title: "Dragon tool holder",
      sourceCategories: ["Creatures", "Miniatures"],
    }),
    "miniatures",
  );
});

test("tags match keywords with plural folding", () => {
  // "puzzles" must hit the singular keyword "puzzle" — keyword lists don't
  // carry both forms.
  assert.equal(suggestCategory(categories, { tags: ["puzzles"] }), "games-toys");
});

test("multi-word keywords only match as a phrase in the title", () => {
  assert.equal(
    suggestCategory(categories, { title: "Scale model of a castle" }),
    "miniatures",
  );
  // "scale" and "model" apart must not count as the "scale model" keyword.
  assert.equal(
    suggestCategory(categories, { title: "Scale for my model paint" }),
    null,
  );
});

test("returns null when nothing matches, so callers fall back to Other", () => {
  // "Other" has no keywords on purpose — it must never win a suggestion.
  assert.equal(
    suggestCategory(categories, {
      title: "Untitled",
      tags: ["misc"],
      sourceCategories: ["Education", "Chemistry"],
    }),
    null,
  );
});
