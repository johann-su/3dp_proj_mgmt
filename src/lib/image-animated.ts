// Detects animated raster images from their leading header bytes. The stored
// content type can't distinguish an animated WebP/PNG from a static one (both
// are image/webp, image/png), so browse cards read this flag to decide whether
// to freeze a cover to its poster frame. A ~256-byte header is enough for every
// format's animation marker; see detectAnimated in @/lib/storage for the read.
export function isAnimatedImage(head: Uint8Array): boolean {
  // GIF: "GIF87a" is always single-frame; "GIF89a" *may* animate. We treat
  // every GIF89a as animated — a single-frame GIF frozen to frame 0 is
  // identical to itself, and proving a second frame exists means scanning the
  // whole file (frames can sit anywhere after the header).
  if (ascii(head, 0, 6) === "GIF89a") return true;
  if (ascii(head, 0, 6) === "GIF87a") return false;

  // WebP: "RIFF"…"WEBP". Only the extended "VP8X" chunk carries the animation
  // flag (bit 1, 0x02, of the flags byte at offset 20). Plain "VP8 "/"VP8L"
  // are always static single images.
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") {
    return ascii(head, 12, 16) === "VP8X" && (head[20] & 0x02) !== 0;
  }

  // PNG: an "acTL" (animation control) chunk makes it an APNG. The spec
  // requires acTL before the first IDAT, and it sits right after IHDR — well
  // inside the header window — so its mere presence is a reliable marker.
  if (ascii(head, 1, 4) === "PNG") return indexOfAscii(head, "acTL") !== -1;

  return false;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  if (bytes.length < end) return "";
  let s = "";
  for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function indexOfAscii(bytes: Uint8Array, needle: string): number {
  for (let i = 0; i + needle.length <= bytes.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle.charCodeAt(j)) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}
