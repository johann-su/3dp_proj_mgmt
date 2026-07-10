import TurndownService from "turndown";

function decodeEntities(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

// Decodes (possibly multiply-escaped) HTML-ish content and flattens it to
// readable plain text with line breaks. Used for slicer/platform descriptions.
export function htmlishToText(raw: string): string {
  let text = raw;
  for (let i = 0; i < 4; i++) {
    const decoded = decodeEntities(text);
    if (decoded === text) break;
    text = decoded;
  }
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h[1-6]|li|div)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Peels off HTML-entity escaping until real tags surface, so both plain HTML
// ("<h3>…") and Bambu Studio's double-escaped variety ("&amp;lt;h3&amp;gt;…")
// reach the parser as actual markup. Once tags are present we stop and let the
// parser decode the remaining entities in text nodes itself.
function decodeToHtml(raw: string): string {
  let text = raw;
  for (let i = 0; i < 4; i++) {
    if (/<[a-z!/][^>]*>/i.test(text)) break;
    const decoded = decodeEntities(text);
    if (decoded === text) break;
    text = decoded;
  }
  return text;
}

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
});

// Converts (possibly multiply-escaped) HTML-ish content to Markdown, preserving
// headings, emphasis, lists, links and images (images stay hot-linked to the
// source CDN, since we don't stage description images to S3). The output is
// rendered by the <Markdown> component, which ignores any raw HTML, so the
// result stays safe to display.
export function htmlishToMarkdown(raw: string): string {
  return turndown
    .turndown(decodeToHtml(raw))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
