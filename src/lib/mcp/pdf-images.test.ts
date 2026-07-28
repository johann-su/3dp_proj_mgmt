import { test } from "node:test";
import assert from "node:assert/strict";
import {
  imageSignature,
  samplePagesForRepeats,
  selectDiagrams,
} from "@/lib/mcp/pdf-images";

const img = (key: string, width: number, height: number) => ({ key, width, height });

// The regression this whole signature scheme exists for. pdf.js gave the same
// 474x120 banner a different key on every page of the Stallion VTOL manual
// (img_p6_2, img_p12_2, img_p16_2 …) while caching the 219x32 logo globally as
// g_d0_img_p1_2 — so a key-based match caught the logo and missed the banner.
test("boilerplate re-keyed on every page is still recognised as repeated", () => {
  const bannerOnThisPage = img("img_p16_2", 474, 120);
  const bannerElsewhere = img("img_p6_2", 474, 120);
  assert.notEqual(bannerOnThisPage.key, bannerElsewhere.key);
  assert.equal(imageSignature(bannerOnThisPage), imageSignature(bannerElsewhere));

  const picked = selectDiagrams(
    [bannerOnThisPage, img("img_p16_3", 1583, 890)],
    new Set([imageSignature(bannerElsewhere)]),
  );

  assert.deepEqual(
    picked.images.map((i) => i.key),
    ["img_p16_3"],
  );
});

// Sizes taken from that manual: the banner is larger than plenty of real
// figures, so size alone cannot separate chrome from content.
test("a repeated banner is dropped even though it clears the size floor", () => {
  const picked = selectDiagrams(
    [img("logo", 474, 200), img("wiring", 800, 600)],
    new Set(["474x200"]),
  );

  assert.deepEqual(
    picked.images.map((i) => i.key),
    ["wiring"],
  );
  assert.equal(picked.skipped, 1);
});

test("a page-specific figure survives when other pages carry different ones", () => {
  // Real diagrams differ in size (1638x1158, 1625x1149, 1583x890), so they
  // never collide with each other's signatures.
  const picked = selectDiagrams([img("fig", 1583, 890)], new Set(["1638x1158", "219x32"]));
  assert.equal(picked.images.length, 1);
});

test("icons and rules below the size floor are page furniture, not figures", () => {
  const picked = selectDiagrams(
    [img("bullet", 24, 24), img("rule", 900, 3), img("real", 700, 500)],
    new Set(),
  );

  assert.deepEqual(
    picked.images.map((i) => i.key),
    ["real"],
  );
  assert.equal(picked.skipped, 2);
});

// Within a page the key is genuinely unique per drawn object, so it is the
// right tool for this job even though it is the wrong one across pages.
test("the same figure painted twice on one page is shown once", () => {
  const picked = selectDiagrams([img("fig", 600, 600), img("fig", 600, 600)], new Set());
  assert.equal(picked.images.length, 1);
});

test("figures come back largest first and are capped per call", () => {
  const picked = selectDiagrams(
    [img("a", 300, 300), img("b", 1600, 900), img("c", 800, 800), img("d", 500, 500)],
    new Set(),
    { maxImages: 2 },
  );

  assert.deepEqual(
    picked.images.map((i) => i.key),
    ["b", "c"],
  );
});

test("a page of nothing but boilerplate returns no images rather than erroring", () => {
  const picked = selectDiagrams([img("logo", 474, 200)], new Set(["474x200"]));
  assert.deepEqual(picked.images, []);
});

test("sampling spreads across the document and never includes the target page", () => {
  const sample = samplePagesForRepeats(24, 17);

  assert.ok(!sample.includes(17));
  assert.equal(new Set(sample).size, sample.length);
  assert.ok(sample.length > 1, "one sample can't distinguish a repeat from a coincidence");
  assert.ok(sample.every((p) => p >= 1 && p <= 24));
});

test("sampling still returns a page for a two-page document", () => {
  // The even-spacing step degenerates here; the fallback has to cover it.
  assert.deepEqual(samplePagesForRepeats(2, 1), [2]);
});

test("a single-page document has nothing to compare against", () => {
  assert.deepEqual(samplePagesForRepeats(1, 1), []);
});
