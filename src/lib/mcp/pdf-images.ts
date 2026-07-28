// The pure half of get_document_images (see tools.ts): deciding which of a PDF
// page's embedded images are worth showing the model.
//
// Why this tool exists: a manual's text layer is often the thin part. The
// Stallion VTOL manual this was built for extracts 24 pages of text totalling
// ~12k characters — page 1 is literally "1USER MANUAL" — while the wiring and
// print-orientation information lives entirely in the pictures. Reading only
// the text answers none of the questions people actually ask.
//
// Extraction comes from unpdf's extractImages, which hands back raw pixel
// buffers rather than encoded files, so nothing here needs pdf.js or sharp —
// the tool does the decoding and encoding, this module only chooses. Keeps it
// unit-testable per AGENTS.md's extract-the-pure-core rule.

/** Shape of one embedded image as unpdf's extractImages returns it. */
export type ExtractedImage = {
  width: number;
  height: number;
  /** pdf.js object id — unique within a page, but see imageSignature for why it isn't used across pages. */
  key: string;
};

/**
 * Identity of an image *across* pages.
 *
 * Deliberately dimensions and not `key`: pdf.js names an image after the page
 * it first decoded it on, and only sometimes promotes it to the global cache.
 * In the manual this was built against the 219x32 logo is cached globally and
 * keeps `g_d0_img_p1_2` on every page, while the 474x120 banner right next to
 * it is re-keyed per page (`img_p6_2`, `img_p12_2`, `img_p16_2`, …) despite
 * being the same picture. Matching on keys would therefore catch half the
 * boilerplate and miss the rest.
 *
 * Exact width x height is the reliable signal: repeated furniture is
 * pixel-identical by construction, whereas real figures differ (that same
 * document's diagrams are 1638x1158, 1625x1149, 1583x890 — no two alike).
 */
export function imageSignature(image: ExtractedImage): string {
  return `${image.width}x${image.height}`;
}

// Below this on either edge an image is furniture — a bullet, a rule, an icon.
// Real diagrams and photos in a manual are hundreds of pixels across.
const MIN_EDGE = 140;
// Wide-but-short banners clear MIN_EDGE on one axis; area catches the rest.
const MIN_PIXELS = 40_000;
// Each image costs the client roughly a thousand tokens, and a page with more
// than a handful of real figures is better read a page at a time anyway.
const MAX_IMAGES_PER_PAGE = 4;

export type DiagramSelection<T> = {
  images: T[];
  /** How many were dropped as page furniture — reported so the model isn't left wondering. */
  skipped: number;
};

/**
 * Picks the meaningful figures out of one page's embedded images.
 *
 * The load-bearing rule is `repeatedSignatures` (see imageSignature): a header
 * logo, footer mark or watermark is re-drawn on every page, whereas a figure
 * that belongs to this page appears only here. Size thresholds alone can't
 * separate them — a banner can easily be larger than a real diagram — so
 * cross-page repetition is what actually distinguishes content from chrome.
 *
 * Largest first: when a page carries one real figure plus some decoration, the
 * figure is almost always the biggest thing on it.
 */
export function selectDiagrams<T extends ExtractedImage>(
  pageImages: T[],
  repeatedSignatures: ReadonlySet<string>,
  { maxImages = MAX_IMAGES_PER_PAGE }: { maxImages?: number } = {},
): DiagramSelection<T> {
  const seen = new Set<string>();
  const kept: T[] = [];

  for (const image of pageImages) {
    // Within one page the key *is* unique per drawn object, so it's the right
    // way to notice the same figure painted twice.
    if (seen.has(image.key)) continue;
    seen.add(image.key);
    if (repeatedSignatures.has(imageSignature(image))) continue;
    if (image.width < MIN_EDGE || image.height < MIN_EDGE) continue;
    if (image.width * image.height < MIN_PIXELS) continue;
    kept.push(image);
  }

  kept.sort((a, b) => b.width * b.height - a.width * a.height);
  return {
    images: kept.slice(0, maxImages),
    skipped: pageImages.length - Math.min(kept.length, maxImages),
  };
}

/**
 * Chooses which other pages to sample to learn what repeats.
 *
 * Boilerplate is on nearly every page, so a handful of samples spread across
 * the document finds it; extracting all of them would mean decoding every
 * image in the file to answer a question about one page.
 */
export function samplePagesForRepeats(
  pageCount: number,
  targetPage: number,
  sampleSize = 3,
): number[] {
  const candidates: number[] = [];
  // Evenly spaced rather than adjacent: facing pages in a spread can share a
  // one-off figure, which would then look like boilerplate.
  const step = Math.max(1, Math.floor(pageCount / (sampleSize + 1)));
  for (let page = 1; page <= pageCount && candidates.length < sampleSize; page += step) {
    if (page !== targetPage) candidates.push(page);
  }
  // A two-page document has nothing to spare; fall back to whatever isn't the target.
  if (candidates.length === 0) {
    for (let page = 1; page <= pageCount && candidates.length < sampleSize; page++) {
      if (page !== targetPage) candidates.push(page);
    }
  }
  return candidates;
}
