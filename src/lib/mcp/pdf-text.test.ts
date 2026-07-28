import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_RESPONSE_CHARS,
  normalizePageText,
  pickDocument,
  selectPages,
} from "@/lib/mcp/pdf-text";
import { ToolError } from "@/lib/mcp/protocol";

// pdf.js emits a text item per positioned run, so raw page text arrives full of
// runs of spaces and blank lines that cost tokens and carry no meaning.
test("normalizePageText collapses pdf.js spacing without losing paragraph breaks", () => {
  const raw = "Step  1:\t connect the   ESC\r\n\n\n\nStep 2:  arm  \n";
  assert.equal(normalizePageText(raw), "Step 1: connect the ESC\n\nStep 2: arm");
});

test("normalizePageText yields an empty string for an image-only page", () => {
  // Wiring diagrams are pictures; the tool reports these as empty rather than
  // pretending the page is missing.
  assert.equal(normalizePageText("   \n\n \t \n"), "");
});

const docs = [
  { filename: "STALLION-MANUAL-VTOL-V2.pdf" },
  { filename: "wiring-diagram.pdf" },
];

test("pickDocument matches a filename case-insensitively", () => {
  assert.equal(pickDocument(docs, "stallion-manual-vtol-v2.pdf").filename, docs[0].filename);
});

test("pickDocument resolves a partial name, which is how models refer to files", () => {
  assert.equal(pickDocument(docs, "wiring").filename, "wiring-diagram.pdf");
});

// Defaulting instead of erroring is deliberate: the response names what it read
// and lists the alternatives, so only a wrong guess costs an extra call.
test("pickDocument defaults to the first document when none is named", () => {
  assert.equal(pickDocument(docs, undefined).filename, docs[0].filename);
});

test("pickDocument refuses an ambiguous partial rather than guessing", () => {
  assert.throws(() => pickDocument(docs, ".pdf"), ToolError);
});

test("pickDocument reports the available filenames when nothing matches", () => {
  assert.throws(() => pickDocument(docs, "schematic"), (err: unknown) => {
    assert.ok(err instanceof ToolError);
    // The model needs the real names to retry without another tool call.
    assert.match(err.message, /wiring-diagram\.pdf/);
    return true;
  });
});

test("pickDocument errors when the model has no documents at all", () => {
  assert.throws(() => pickDocument([], undefined), ToolError);
});

test("selectPages takes whole pages until the budget is spent", () => {
  const pages = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
  const slice = selectPages(pages, { startPage: 1, budget: 100 });

  assert.deepEqual(
    slice.pages.map((p) => p.page),
    [1, 2],
  );
  // Page 3 didn't fit, so the caller is told where to resume.
  assert.equal(slice.nextStartPage, 3);
  assert.equal(slice.pageTruncated, false);
});

test("selectPages signals the end of the document with a null nextStartPage", () => {
  const slice = selectPages(["one", "two"], { startPage: 2, budget: 100 });

  assert.deepEqual(slice.pages, [{ page: 2, text: "two" }]);
  assert.equal(slice.nextStartPage, null);
});

// Without this branch a page bigger than the whole budget would return zero
// pages, leaving the caller with nothing to read and nowhere to advance to.
test("selectPages cuts a single oversized page and resumes on that same page", () => {
  const slice = selectPages(["x".repeat(500)], { startPage: 1, budget: 100 });

  assert.equal(slice.pages.length, 1);
  assert.equal(slice.pages[0].text.length, 100);
  assert.equal(slice.pageTruncated, true);
  assert.equal(slice.nextStartPage, 1);
});

test("selectPages rejects a startPage past the end of the document", () => {
  assert.throws(() => selectPages(["only page"], { startPage: 4 }), (err: unknown) => {
    assert.ok(err instanceof ToolError);
    assert.match(err.message, /1 page/);
    return true;
  });
});

test("selectPages handles a PDF that yielded no pages", () => {
  assert.deepEqual(selectPages([], {}), {
    pages: [],
    nextStartPage: null,
    pageTruncated: false,
  });
});

// The budget is halved by toolResult serializing every payload twice (text
// block + structuredContent), and must clear Claude Code's 25k-token cap.
test("the default budget leaves headroom under both client result caps", () => {
  assert.ok(MAX_RESPONSE_CHARS * 2 < 100_000);
});
