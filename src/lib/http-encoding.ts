// Response compression for route handlers that send large binary bodies. Next.js only gzips types its compression filter considers compressible, which excludes application/octet-stream — so the customizer's preview STL (megabytes of mostly-repeated float data, 2.5–7x smaller compressed) would otherwise go out raw.
//
// The negotiation is pure and unit-tested (src/lib/http-encoding.test.ts); compressBody only wraps node:zlib.

import { promisify } from "node:util";
import zlib from "node:zlib";

export type ContentEncoding = "br" | "gzip";

// The encoding to answer an Accept-Encoding header with, or null to send the body as is. Brotli wins when both are acceptable (browsers offer it over HTTPS); an explicit q=0 excludes an encoding, and a bare "*" stands for any encoding not listed by name.
export function pickContentEncoding(
  acceptEncoding: string | null | undefined,
): ContentEncoding | null {
  if (!acceptEncoding) return null;
  const weights = new Map<string, number>();
  for (const part of acceptEncoding.split(",")) {
    const [rawName, ...params] = part.split(";");
    const name = rawName.trim().toLowerCase();
    if (!name) continue;
    const q = params
      .map((p) => /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p))
      .find((m) => m !== null);
    const weight = q ? Number(q[1]) : 1;
    weights.set(name, Number.isFinite(weight) ? weight : 0);
  }
  const weightOf = (name: ContentEncoding) => weights.get(name) ?? weights.get("*") ?? 0;
  const br = weightOf("br");
  const gzip = weightOf("gzip");
  if (br <= 0 && gzip <= 0) return null;
  return br >= gzip ? "br" : "gzip";
}

const brotliCompress = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

// Fast settings on purpose: the body is compressed once per request on the hot path of a live preview. Brotli quality 5 / gzip level 1 compress a 4 MB STL in ~35 ms / ~25 ms; the higher levels take 2–4x longer for a few percent. zlib runs on the libuv thread pool, so this doesn't block the event loop.
export function compressBody(
  data: Uint8Array,
  encoding: ContentEncoding,
): Promise<Buffer<ArrayBuffer>> {
  // zlib's buffers are always backed by a plain ArrayBuffer (never shared), but its typings say ArrayBufferLike, which a Response body won't accept.
  return (encoding === "br"
    ? brotliCompress(data, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
        },
      })
    : gzip(data, { level: 1 })) as Promise<Buffer<ArrayBuffer>>;
}
