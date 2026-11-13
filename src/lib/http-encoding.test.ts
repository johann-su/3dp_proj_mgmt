import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { compressBody, pickContentEncoding } from "@/lib/http-encoding";

// What browsers send over HTTPS — the common production case.
test("a browser offering brotli gets brotli", () => {
  assert.equal(pickContentEncoding("gzip, deflate, br, zstd"), "br");
});

// Browsers only offer brotli on secure origins; plain-HTTP self-hosted instances still get compression.
test("without brotli, gzip is used", () => {
  assert.equal(pickContentEncoding("gzip, deflate"), "gzip");
});

test("no header, or only encodings we don't produce, means no compression", () => {
  assert.equal(pickContentEncoding(null), null);
  assert.equal(pickContentEncoding(""), null);
  assert.equal(pickContentEncoding("identity"), null);
  assert.equal(pickContentEncoding("deflate, zstd"), null);
});

test("q=0 excludes an encoding, and a higher q beats our brotli preference", () => {
  assert.equal(pickContentEncoding("br;q=0, gzip"), "gzip");
  assert.equal(pickContentEncoding("gzip;q=1, br;q=0.5"), "gzip");
  assert.equal(pickContentEncoding("br;q=0, gzip;q=0"), null);
});

test("a wildcard covers encodings not listed by name", () => {
  assert.equal(pickContentEncoding("*"), "br");
  assert.equal(pickContentEncoding("br;q=0, *"), "gzip");
  assert.equal(pickContentEncoding("*;q=0"), null);
});

// The body must actually be in the codec the Content-Encoding header will name, or the browser fails to decode the response.
test("compressBody output decodes with the matching codec", async () => {
  const data = new Uint8Array(64 * 1024).map((_, i) => i % 7);
  const br = await compressBody(data, "br");
  const gz = await compressBody(data, "gzip");
  assert.ok(br.length < data.length && gz.length < data.length);
  assert.deepEqual(new Uint8Array(zlib.brotliDecompressSync(br)), data);
  assert.deepEqual(new Uint8Array(zlib.gunzipSync(gz)), data);
});
