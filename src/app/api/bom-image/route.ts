import { NextRequest, NextResponse } from "next/server";
import { lookup } from "node:dns/promises";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bomItems } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { allowedBomImageType } from "@/lib/bom";
import { isPrivateOrReservedIp } from "@/lib/net-guard";
import { resolveShareLink, shareGrantsModel } from "@/lib/share-links";

export const runtime = "nodejs";

const FETCH_TIMEOUT_MS = 8_000;
const MAX_BYTES = 8 * 1024 * 1024; // generous for a vendor product photo

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Streams a BOM item's externally-linked image (Amazon/AliExpress/vendor
// product photos, not a file we host) through our own origin so it survives
// the strict `img-src 'self' data: blob:` CSP (next.config.ts) now that the
// catalog is internet-facing — a bare <img src="https://vendor/..."> is
// blocked outright. Two ways in:
//
//  - `?url=<image url>` — signed-in members (bomImageProxySrc). The URL is
//    attacker-reachable (any signed-in collaborator can set it on a BOM
//    item), so this mode is never opened to anonymous callers.
//  - `?share=<token>&item=<bom item id>` — public share links
//    (sharedBomImageSrc). The caller names an *item*, not a URL: the share is
//    re-checked against the item's model and only the URL stored on that item
//    is fetched, so an anonymous visitor can't aim the fetch anywhere a
//    collaborator hasn't already put it, and revoking the link stops it.
//
// Either way the hostname is resolved and private/loopback/link-local/metadata
// addresses are rejected before fetching, redirects are never followed, and
// the server-side fetch carries no client cookies or headers. It does not
// defend against DNS-rebinding between the lookup and the fetch itself; that's
// an accepted gap given the URLs are only writable by authenticated
// collaborators, not the public internet.
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const shareToken = params.get("share");

  let raw: string | null;
  let cacheControl: string;
  if (shareToken !== null) {
    const notFound = NextResponse.json({ error: "Not found" }, { status: 404 });
    const itemId = params.get("item") ?? "";
    if (!UUID_RE.test(itemId)) return notFound;
    const share = await resolveShareLink(shareToken);
    if (!share) return notFound;
    const item = await db.query.bomItems.findFirst({
      where: eq(bomItems.id, itemId),
      columns: { modelId: true, imageUrl: true },
    });
    if (!item?.imageUrl || !(await shareGrantsModel(share, item.modelId))) {
      return notFound;
    }
    raw = item.imageUrl;
    // Short, like the shared file route, so a revoked link stops serving.
    cacheControl = "private, max-age=300";
  } else {
    if (!(await getSession())) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    raw = params.get("url");
    if (!raw) {
      return NextResponse.json({ error: "Missing url" }, { status: 400 });
    }
    // Private: keyed by the requester's cookie-authenticated fetch, not meant
    // for shared/CDN caches; the browser can still reuse it for a day.
    cacheControl = "private, max-age=86400";
  }

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return NextResponse.json({ error: "Invalid url" }, { status: 400 });
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return NextResponse.json({ error: "Invalid url" }, { status: 400 });
  }

  try {
    const addresses = await lookup(target.hostname, { all: true });
    if (
      addresses.length === 0 ||
      addresses.some((a) => isPrivateOrReservedIp(a.address))
    ) {
      return NextResponse.json({ error: "Host not allowed" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Host not allowed" }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "image/*" },
    });
  } catch {
    return NextResponse.json({ error: "Fetch failed" }, { status: 502 });
  }

  // Raster types only — an SVG is image/* too, but served from our origin and
  // opened directly it would run its <script> as the viewer.
  const contentType = allowedBomImageType(upstream.headers.get("content-type"));
  if (!upstream.ok || !contentType) {
    return NextResponse.json({ error: "Not an image" }, { status: 502 });
  }
  const contentLength = Number(upstream.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BYTES || !upstream.body) {
    return NextResponse.json({ error: "Image too large" }, { status: 502 });
  }

  // Enforce the size cap even if upstream omitted (or lied about)
  // Content-Length, by counting bytes as they stream through.
  let seen = 0;
  const limited = upstream.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > MAX_BYTES) {
          controller.error(new Error("Image too large"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );

  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("X-Content-Type-Options", "nosniff");
  // The locked-down CSP for these responses is set in next.config.ts — a
  // route-level header would be overridden by the global CSP there.
  headers.set("Cache-Control", cacheControl);
  return new Response(limited, { headers });
}
