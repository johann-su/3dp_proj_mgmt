import { test } from "node:test";
import assert from "node:assert/strict";
import { parseByteRange, toS3Range } from "@/lib/http-range";

// The request a <video> element opens with. It must produce a real range (and
// so a 206), because Safari treats a plain 200 as "this server can't seek" and
// refuses to play the source at all.
test("an open-ended range runs to the last byte", () => {
  assert.deepEqual(parseByteRange("bytes=0-", 1000), { start: 0, end: 999 });
});

test("a closed range is taken as given, inclusive of both ends", () => {
  assert.deepEqual(parseByteRange("bytes=100-199", 1000), { start: 100, end: 199 });
});

// Seeking near the end of a file routinely asks for more than is there.
test("an end past the last byte is clamped, not rejected", () => {
  assert.deepEqual(parseByteRange("bytes=900-5000", 1000), { start: 900, end: 999 });
});

test("a suffix range counts back from the end", () => {
  assert.deepEqual(parseByteRange("bytes=-200", 1000), { start: 800, end: 999 });
  // Asking for more trailing bytes than exist is the whole object, not an error.
  assert.deepEqual(parseByteRange("bytes=-5000", 1000), { start: 0, end: 999 });
});

// The one case that must NOT degrade to "serve everything": a start past the
// end is unsatisfiable, and the spec's answer is 416 with the real length.
test("a start at or past the end is unsatisfiable", () => {
  assert.equal(parseByteRange("bytes=1000-", 1000), "unsatisfiable");
  assert.equal(parseByteRange("bytes=5000-6000", 1000), "unsatisfiable");
});

// Everything we don't fully understand degrades to a whole-object 200, which
// is always a legal response to a Range request.
test("absent, malformed and multi-range headers fall back to the whole object", () => {
  assert.equal(parseByteRange(null, 1000), null);
  assert.equal(parseByteRange("", 1000), null);
  assert.equal(parseByteRange("items=0-10", 1000), null);
  assert.equal(parseByteRange("bytes=abc-def", 1000), null);
  assert.equal(parseByteRange("bytes=-", 1000), null);
  // A reversed range names no bytes at all.
  assert.equal(parseByteRange("bytes=500-100", 1000), null);
  // Multipart responses would need a multipart/byteranges body; no consumer
  // needs one, so the whole object is served instead.
  assert.equal(parseByteRange("bytes=0-99,200-299", 1000), null);
});

// A zero-length or unknown size can't produce a meaningful range.
test("a size of zero yields no range", () => {
  assert.equal(parseByteRange("bytes=0-", 0), null);
});

test("toS3Range always emits the resolved absolute range", () => {
  // S3 gets the fully-resolved form, never the suffix shorthand the client
  // sent — the two would otherwise disagree about what was served.
  assert.equal(toS3Range({ start: 800, end: 999 }), "bytes=800-999");
});
