import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { modelFiles } from "@/db/schema";
import { isGalleryKind } from "@/lib/file-kind";
import { getSession } from "@/lib/auth";
import { verifyFileToken } from "@/lib/file-token";
import { serveModelFile } from "@/lib/serve-file";

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

  // Files are content-addressed by an immutable UUID, so an image never changes
  // under a given URL — let the browser and the next/image optimizer cache it
  // aggressively (the optimizer's TTL is max(minimumCacheTTL, upstream max-age)).
  // Only token-authenticated responses are cacheable by shared caches: the
  // token in the URL keys the cache, so a cached copy is only reachable with a
  // valid token. Cookie-authenticated responses stay private so a proxy can't
  // serve one user's fetch to anonymous clients under the token-less URL.
  return serveModelFile(req, file, {
    cacheControl:
      isGalleryKind(file.kind) && viaToken
        ? "public, max-age=31536000, immutable"
        : "private, max-age=3600",
  });
}
