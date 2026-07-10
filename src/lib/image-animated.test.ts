import { test } from "node:test";
import assert from "node:assert/strict";
import { isAnimatedImage } from "@/lib/image-animated";

// Builds a minimal WebP header: RIFF <size> WEBP <fourcc> … with the VP8X
// flags byte at offset 20. Only the parts isAnimatedImage inspects matter.
function webp(fourcc: string, flags = 0): Uint8Array {
  const b = new Uint8Array(32);
  b.set([...Buffer.from("RIFF")], 0);
  b.set([...Buffer.from("WEBP")], 8);
  b.set([...Buffer.from(fourcc.padEnd(4))], 12);
  b[20] = flags;
  return b;
}

test("animated WebP is detected via the VP8X animation flag", () => {
  // VP8X with bit 0x02 set — the case content type ("image/webp") can't reveal.
  assert.equal(isAnimatedImage(webp("VP8X", 0x02)), true);
});

test("still WebP is not animated (VP8X without the flag, and plain VP8)", () => {
  assert.equal(isAnimatedImage(webp("VP8X", 0x00)), false);
  assert.equal(isAnimatedImage(webp("VP8 ")), false);
});

test("GIF89a counts as animated, GIF87a does not", () => {
  // Freezing a single-frame GIF89a to frame 0 is a no-op, so treating every
  // GIF89a as animated is safe and avoids scanning for a real second frame.
  assert.equal(isAnimatedImage(Buffer.from("GIF89a....")), true);
  assert.equal(isAnimatedImage(Buffer.from("GIF87a....")), false);
});

test("APNG is animated (acTL chunk), plain PNG is not", () => {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]; // ‰PNG…
  const apng = new Uint8Array([...sig, ...Buffer.from("....acTL....")]);
  const png = new Uint8Array([...sig, ...Buffer.from("....IDAT....")]);
  assert.equal(isAnimatedImage(apng), true);
  assert.equal(isAnimatedImage(png), false);
});

test("unknown/truncated data is treated as not animated", () => {
  assert.equal(isAnimatedImage(new Uint8Array(0)), false);
  assert.equal(isAnimatedImage(Buffer.from("RIFF")), false);
});
