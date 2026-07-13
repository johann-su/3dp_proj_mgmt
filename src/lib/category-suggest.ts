// Pure category suggestion — DB-free so it runs in the create-form client
// bundle and in the collection-import job alike (and is unit-testable).
//
// A category's `keywords` (plus its name) are matched against three signals,
// strongest first:
//   1. the source platform's own category names (MakerWorld's `categories`,
//      Printables' `category.path`) — the platform already classified the
//      model, so an indicator match here should dominate;
//   2. the model's tags;
//   3. words in the title.
// Descriptions are ignored on purpose: they are long and noisy ("print with
// any tool you like" should not suggest Tools).
//
// Matching is token-based with singular/plural folding ("puzzles" matches the
// keyword "puzzle") so keyword lists don't need both forms. Multi-word
// keywords must appear as a consecutive phrase. Nothing matched → null; the
// caller falls back to the "Other" category (no model stays uncategorized).

export type SuggestableCategory = {
  id: string;
  name: string;
  keywords: string[];
};

export type CategorySignals = {
  title?: string;
  tags?: string[];
  // Source platform category names, most specific first (e.g. MakerWorld's
  // ["Signs & Logos", "Art"]). Only used as a ranking indicator against the
  // existing categories — never creates new ones.
  sourceCategories?: string[];
};

const SOURCE_WEIGHT = 5;
const TAG_WEIGHT = 3;
const TITLE_WEIGHT = 2;

// "d&d" stays one token; everything else splits on non-alphanumerics.
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9&]+/)
    .filter(Boolean);
}

// Singular/plural folding: "logos" matches "logo" and vice versa.
function wordsEqual(a: string, b: string): boolean {
  return a === b || a === `${b}s` || `${a}s` === b;
}

// True when the keyword's tokens appear as a consecutive phrase in the text.
function phraseIn(textTokens: string[], keywordTokens: string[]): boolean {
  if (keywordTokens.length === 0) return false;
  outer: for (let i = 0; i + keywordTokens.length <= textTokens.length; i++) {
    for (let j = 0; j < keywordTokens.length; j++) {
      if (!wordsEqual(textTokens[i + j], keywordTokens[j])) continue outer;
    }
    return true;
  }
  return false;
}

// Returns the id of the best-matching category, or null when no signal
// matches any keyword (the caller should then fall back to "Other").
export function suggestCategory(
  categories: SuggestableCategory[],
  signals: CategorySignals,
): string | null {
  const titleTokens = tokenize(signals.title ?? "");
  const tagTokens = (signals.tags ?? []).map(tokenize);
  const sourceTokens = (signals.sourceCategories ?? []).map(tokenize);

  let bestId: string | null = null;
  let bestScore = 0;

  for (const category of categories) {
    const terms = [category.name, ...category.keywords].map(tokenize);
    let score = 0;
    // Each signal counts once per keyword list, not once per keyword — a
    // category shouldn't win just because several of its synonyms overlap
    // the same source category name.
    for (const source of sourceTokens) {
      if (terms.some((term) => phraseIn(source, term))) score += SOURCE_WEIGHT;
    }
    for (const tag of tagTokens) {
      if (terms.some((term) => phraseIn(tag, term))) score += TAG_WEIGHT;
    }
    if (terms.some((term) => phraseIn(titleTokens, term))) score += TITLE_WEIGHT;

    if (score > bestScore) {
      bestScore = score;
      bestId = category.id;
    }
  }

  return bestId;
}
