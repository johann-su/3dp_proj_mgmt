// The pure half of read_document (see tools.ts): picking which attached PDF the
// caller meant, tidying pdf.js's per-page text, and slicing that text into
// responses a client will actually accept.
//
// Why the tool exists at all: get_model_documents hands out a signed
// downloadUrl, and an LLM client is not guaranteed to be able to fetch it.
// claude.ai's web_fetch only follows URLs that came from the user's own message
// or from web_search results, so a URL that appeared only in an MCP tool result
// comes back "Failed to fetch" no matter how permissive robots.txt and the
// reverse proxy are. Reading the text over the MCP channel sidesteps the
// question entirely — the bytes travel back through the same authenticated
// call the client already made.
//
// No S3 and no pdf.js in here: the tool hands in the already-extracted page
// text, which keeps this unit-testable (AGENTS.md's extract-the-pure-core
// rule) — pdf-text.test.ts needs no fixtures and no network.

import { ToolError } from "@/lib/mcp/protocol";

// Per-call character budget for extracted text. Deliberately conservative:
// every tool payload is serialized *twice* (once as the text block every
// client shows the model, once as structuredContent — see toolResult), so the
// response carries roughly double this number. That has to stay under both
// caps in play: ~150k characters on claude.ai/Desktop before a result is
// spilled to the sandbox filesystem, and 25k tokens in Claude Code
// (MAX_MCP_OUTPUT_TOKENS). A manual longer than this is paged through with
// startPage rather than truncated.
export const MAX_RESPONSE_CHARS = 30_000;

/**
 * Tidies one page of pdf.js output. Extraction emits a text item per
 * positioned run, so the raw string is full of stray spacing that costs tokens
 * and tells the model nothing. Layout is not preserved — this is prose for
 * reading, not a faithful rendering.
 */
export function normalizePageText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    // Non-breaking and other exotic spaces read as literal glyphs otherwise.
    .replace(/[   ]/g, " ")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    // A blank line is a paragraph break worth keeping; three are not.
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type DocumentChoice = { filename: string };

/**
 * Resolves the `filename` argument against a model's attached PDFs.
 *
 * Matching is forgiving in the direction models get it wrong: they echo a
 * filename with the wrong case, or name the manual ("wiring") rather than the
 * file. An unqualified call on a multi-document model reads the first one
 * rather than erroring — the response names what it read and lists the rest,
 * which costs the model one extra call only when it guessed wrong, instead of
 * costing every caller a round trip.
 */
export function pickDocument<T extends DocumentChoice>(
  documents: T[],
  requested?: string,
): T {
  if (documents.length === 0) {
    throw new ToolError(
      "This model has no documents attached. get_model reports how many each model has.",
    );
  }
  if (!requested) return documents[0];

  const wanted = requested.trim().toLowerCase();
  const exact = documents.filter((d) => d.filename.toLowerCase() === wanted);
  if (exact.length > 0) return exact[0];

  const partial = documents.filter((d) => d.filename.toLowerCase().includes(wanted));
  if (partial.length === 1) return partial[0];

  const available = documents.map((d) => d.filename).join(", ");
  throw new ToolError(
    partial.length > 1
      ? `"${requested}" matches more than one document (${partial
          .map((d) => d.filename)
          .join(", ")}). Use the exact filename.`
      : `This model has no document named "${requested}". Available: ${available}`,
  );
}

export type PageSlice = {
  pages: { page: number; text: string }[];
  /** 1-based page to pass as startPage next, or null when the end was reached. */
  nextStartPage: number | null;
  /** True when a single page alone exceeded the budget and was cut mid-page. */
  pageTruncated: boolean;
};

/**
 * Takes whole pages from `startPage` until the character budget is spent.
 *
 * Pages are the unit on purpose: a page boundary is a place a model can resume
 * from and cite, whereas an arbitrary character offset is neither. The one
 * exception is a single page larger than the whole budget, which is cut so the
 * call still returns something rather than failing.
 */
export function selectPages(
  pageTexts: string[],
  { startPage = 1, budget = MAX_RESPONSE_CHARS }: { startPage?: number; budget?: number } = {},
): PageSlice {
  if (pageTexts.length === 0) {
    return { pages: [], nextStartPage: null, pageTruncated: false };
  }
  if (startPage < 1 || startPage > pageTexts.length) {
    throw new ToolError(
      `startPage ${startPage} is out of range — this document has ${pageTexts.length} page(s).`,
    );
  }

  const pages: { page: number; text: string }[] = [];
  let used = 0;
  let pageTruncated = false;
  let index = startPage - 1;

  for (; index < pageTexts.length; index++) {
    const text = pageTexts[index];
    if (pages.length > 0 && used + text.length > budget) break;
    if (pages.length === 0 && text.length > budget) {
      // First page of the slice and it alone overflows: emit what fits so the
      // caller is never handed an empty result it can't page past.
      pages.push({ page: index + 1, text: text.slice(0, budget) });
      pageTruncated = true;
      used = budget;
      index++;
      break;
    }
    pages.push({ page: index + 1, text });
    used += text.length;
  }

  return {
    pages,
    // A truncated page is not finished, so the caller is sent back to it.
    nextStartPage: pageTruncated
      ? index
      : index < pageTexts.length
        ? index + 1
        : null,
    pageTruncated,
  };
}
