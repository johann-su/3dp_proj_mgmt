import { NextRequest, NextResponse, after } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { modelFiles } from "@/db/schema";
import { s3, S3_BUCKET, contentTypeForFilename, isGalleryKind } from "@/lib/s3";
import { getSession } from "@/lib/auth";
import { verifyFileToken } from "@/lib/file-token";
import { incrementFileDownloadCount } from "@/lib/metrics";
import { parseByteRange, toS3Range } from "@/lib/http-range";

export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Serves a stored file. Requires either a session cookie (browser downloads,
// <a href> links) or a signed file token (`?token=` or the token path segment
// of /api/files/[id]/[token]/[filename]) for the two cookie-less consumers:
// the next/image optimizer and slicer deep links. See src/lib/file-token.ts.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; token?: string }> },
) {
  const { id, token: pathToken } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const token = pathToken ?? req.nextUrl.searchParams.get("token");
  const viaToken = !!token && verifyFileToken(id, token);
  if (!viaToken && !(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const file = await db.query.modelFiles.findFirst({
    where: eq(modelFiles.id, id),
  });
  if (!file) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Seeking a video sends a Range header; answer it with 206 + Content-Range
  // rather than the whole object (Safari won't play a source that doesn't).
  const range = parseByteRange(req.headers.get("range"), file.size);
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${file.size}` },
    });
  }

  const object = await s3.send(
    new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: file.s3Key,
      ...(range ? { Range: toS3Range(range) } : {}),
    }),
  );
  if (!object.Body) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const asAttachment =
    file.kind === "model" || req.nextUrl.searchParams.get("download") === "1";
  // Only count real downloads, not inline image views (gallery thumbnails,
  // the next/image optimizer) — and not each of the many range requests a
  // video player makes while scrubbing.
  if (asAttachment && !range) after(() => incrementFileDownloadCount(file.id));

  const headers = new Headers();
  // Content type comes from the allowlisted extension, not the stored value:
  // the stored one originally echoed the uploader's header, and serving an
  // attacker-chosen type inline (text/html) on our origin would be stored XSS.
  headers.set("Content-Type", contentTypeForFilename(file.filename));
  headers.set("X-Content-Type-Options", "nosniff");
  if (object.ContentLength !== undefined) {
    headers.set("Content-Length", String(object.ContentLength));
  }
  // Advertised unconditionally so a player knows it may seek before it has
  // issued its first range request.
  headers.set("Accept-Ranges", "bytes");
  if (range) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${file.size}`);
  }
  headers.set(
    "Content-Disposition",
    `${asAttachment ? "attachment" : "inline"}; filename="${encodeURIComponent(file.filename)}"`,
  );
  // Files are content-addressed by an immutable UUID, so an image never changes
  // under a given URL — let the browser and the next/image optimizer cache it
  // aggressively (the optimizer's TTL is max(minimumCacheTTL, upstream max-age)).
  // Only token-authenticated responses are cacheable by shared caches: the
  // token in the URL keys the cache, so a cached copy is only reachable with a
  // valid token. Cookie-authenticated responses stay private so a proxy can't
  // serve one user's fetch to anonymous clients under the token-less URL.
  headers.set(
    "Cache-Control",
    isGalleryKind(file.kind) && viaToken
      ? "public, max-age=31536000, immutable"
      : "private, max-age=3600",
  );

  return new Response(object.Body.transformToWebStream(), {
    status: range ? 206 : 200,
    headers,
  });
}
