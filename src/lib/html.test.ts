import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlishToText } from "@/lib/html";

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
