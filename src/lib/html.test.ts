import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlishToText, htmlishToMarkdown } from "@/lib/html";

test("htmlishToText flattens HTML to plain text with line breaks", () => {
  assert.equal(
    htmlishToText("<h3>Parts</h3><p>Two screws<br>One nut</p>"),
    "Parts\nTwo screws\nOne nut",
  );
});

test("htmlishToText unwraps double-escaped HTML (Bambu Studio descriptions)", () => {
  assert.equal(
    htmlishToText("&amp;lt;h3&amp;gt;Assembly&amp;lt;/h3&amp;gt;Use glue"),
    "Assembly\nUse glue",
  );
});

test("htmlishToText decodes named and numeric entities", () => {
  assert.equal(htmlishToText("90&#176; bracket &amp; nut&nbsp;(M3)"), "90° bracket & nut (M3)");
});

test("htmlishToText collapses runs of blank lines and trims", () => {
  assert.equal(htmlishToText("<p>a</p><p></p><p></p><p>b</p>  "), "a\n\nb");
});

test("htmlishToText leaves plain text untouched", () => {
  assert.equal(htmlishToText("Just a description."), "Just a description.");
});

// htmlishToMarkdown keeps the source formatting so the <Markdown> renderer can
// re-render headings/emphasis/lists/links, instead of flattening to plain text.
test("htmlishToMarkdown preserves headings, emphasis, lists and links", () => {
  assert.equal(
    htmlishToMarkdown(
      '<h3>Parts</h3><p>Two <strong>screws</strong><br>One <a href="http://x.com">nut</a></p><ul><li>a</li><li>b</li></ul>',
    ),
    "### Parts\n\nTwo **screws**  \nOne [nut](http://x.com)\n\n-   a\n-   b",
  );
});

// Bambu Studio descriptions arrive double-escaped ("&amp;lt;h3&amp;gt;…"); the
// entity peeling must expose real tags before conversion.
test("htmlishToMarkdown unwraps double-escaped HTML into markdown", () => {
  assert.equal(
    htmlishToMarkdown("&amp;lt;h3&amp;gt;Assembly&amp;lt;/h3&amp;gt;Use glue"),
    "### Assembly\n\nUse glue",
  );
});

// Embedded images stay hot-linked to the source CDN (we don't stage them to S3).
test("htmlishToMarkdown keeps embedded images pointing at the source", () => {
  assert.equal(
    htmlishToMarkdown('<p>hi <img src="http://cdn/x.png" alt="z"> there</p>'),
    "hi ![z](http://cdn/x.png) there",
  );
});

test("htmlishToMarkdown leaves plain text untouched", () => {
  assert.equal(htmlishToMarkdown("Just a description."), "Just a description.");
});
