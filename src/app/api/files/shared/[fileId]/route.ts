import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { modelFiles } from "@/db/schema";
import { resolveShareLink, shareGrantsModel } from "@/lib/share-links";
import { serveModelFile } from "@/lib/serve-file";

export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Serves a file to an anonymous holder of a public share link: `?share=<token>`
// (sharedFileSrc) or the token path segment of
// /api/files/shared/[fileId]/[token]/[filename] (slicer deep links). Unlike /api/files/[id]'s week-long
// file tokens, the share is re-checked on every request — the link still
// exists, sharing is enabled, and the file's model is the shared model or a
// current member of the shared collection — so revoking a link (or removing a
// model from a shared collection) cuts its files off at once. Every failure is
// the same 404, so the route can't be used to probe which ids exist.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ fileId: string; token?: string }> },
) {
  const { fileId, token: pathToken } = await params;
  const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!UUID_RE.test(fileId)) return notFound();

  const share = await resolveShareLink(pathToken ?? req.nextUrl.searchParams.get("share"));
  if (!share) return notFound();

  const file = await db.query.modelFiles.findFirst({
    where: eq(modelFiles.id, fileId),
  });
  if (!file || !(await shareGrantsModel(share, file.modelId))) return notFound();

  // Never cacheable by shared caches (a CDN would keep serving it after the
  // link is revoked), and only briefly by the viewer's browser. The next/image
  // optimizer still keeps its own copy for minimumCacheTTL — an accepted gap,
  // reachable only through the optimizer URL of someone who had the link.
  return serveModelFile(req, file, {
    cacheControl: "private, max-age=300",
    extraHeaders: { "X-Robots-Tag": "noindex, nofollow" },
  });
}
