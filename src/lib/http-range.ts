// Byte-range parsing for the file routes. Videos are the reason this exists:
// a <video> element asks for ranges to seek (and Safari refuses to play a
// source at all unless the server answers 206), so /api/files must serve
// partial content rather than always streaming the whole object.
//
// Pure and dependency-free so it can be unit-tested without an S3 client —
// the routes only turn the result into headers (see src/lib/http-range.test.ts).

export type ByteRange = { start: number; end: number };

// What a Range header asks for, given the object's size:
//   null             no (usable) range — serve the whole object with 200
//   "unsatisfiable"  a range that starts past the end — the caller must 416
//   {start, end}     an inclusive, clamped range to serve with 206
//
// Deliberately conservative: anything we don't fully understand (a unit other
// than bytes, a multi-range request, a malformed value) degrades to null, and
// serving the whole object is always a valid answer to a Range request.
export function parseByteRange(
  header: string | null | undefined,
  size: number,
): ByteRange | null | "unsatisfiable" {
  if (!header || !Number.isSafeInteger(size) || size <= 0) return null;

  const match = /^bytes=(.*)$/i.exec(header.trim());
  if (!match) return null;

  const spec = match[1].trim();
  // Multipart ranges would need a multipart/byteranges body; no client we
  // serve needs one, and the whole object is a legal response.
  if (spec.includes(",")) return null;

  const parts = /^(\d*)-(\d*)$/.exec(spec);
  if (!parts) return null;
  const [, rawStart, rawEnd] = parts;

  // "bytes=-500" — the *last* 500 bytes. A suffix longer than the object is
  // the whole object, not an error.
  if (rawStart === "") {
    if (rawEnd === "") return null;
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start)) return null;
  if (start >= size) return "unsatisfiable";

  // An open-ended "bytes=0-" (what a <video> opens with) runs to the end, and
  // an end past the last byte is clamped rather than rejected.
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isSafeInteger(end) || end < start) return null;

  return { start, end };
}

// The value for the Range header sent on to S3 (GetObjectCommand takes the
// header verbatim), always the fully-resolved absolute form.
export function toS3Range(range: ByteRange): string {
  return `bytes=${range.start}-${range.end}`;
}
