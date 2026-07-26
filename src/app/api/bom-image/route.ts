import { NextRequest, NextResponse } from "next/server";
import { lookup } from "node:dns/promises";
import { getSession } from "@/lib/auth";
import { isPrivateOrReservedIp } from "@/lib/net-guard";

export const runtime = "nodejs";

const FETCH_TIMEOUT_MS = 8_000;
const MAX_BYTES = 8 * 1024 * 1024; // generous for a vendor product photo

// Streams a BOM item's externally-linked image (Amazon/AliExpress/vendor
// product photos, not a file we host) through our own origin so it survives
// the strict `img-src 'self' data: blob:` CSP (next.config.ts) now that the
// catalog is internet-facing — a bare <img src="https://vendor/..."> is
// blocked outright. `imageUrl` is attacker-reachable (any signed-in
// collaborator can set it on a BOM item), so this resolves the hostname and
// rejects private/loopback/link-local/metadata addresses before fetching,
// and never follows redirects — the classic ways an "image URL" field turns
// into SSRF against internal services. It does not defend against
// DNS-rebinding between the lookup and the fetch itself; that's an accepted
// gap given the field is only writable by already-authenticated
// collaborators, not the public internet.
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw = req.nextUrl.searchParams.get("url");
  if (!raw) {
    return NextResponse.json({ error: "Missing url" }, { status: 400 });
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

  const contentType = upstream.headers.get("content-type") ?? "";
  if (!upstream.ok || !contentType.startsWith("image/")) {
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
  // Private: keyed by the requester's cookie-authenticated fetch, not meant
  // for shared/CDN caches; the browser can still reuse it for a day.
  headers.set("Cache-Control", "private, max-age=86400");
  return new Response(limited, { headers });
}
