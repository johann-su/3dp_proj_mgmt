import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { modelVersions } from "@/db/schema";
import { s3, S3_BUCKET, contentTypeForFilename, isGalleryKind } from "@/lib/s3";
import { getSession } from "@/lib/auth";
import { verifyFileToken, versionFileTokenId } from "@/lib/file-token";
import { parseByteRange, toS3Range } from "@/lib/http-range";

export const runtime = "nodejs";

// Serves one file of a version snapshot for the version-preview page
// (/models/[id]/versions/[versionId]). Historical files have no model_files
// row — they are addressed as (version row, index into its snapshot file
// list), both immutable. Auth mirrors /api/files/[id]: a session cookie or a
// signed token (the next/image optimizer sends no cookies). Downloads are
// not counted — inspecting history isn't a download metric.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ versionId: string; index: string }> },
) {
  const raw = await params;
  const versionId = Number(raw.versionId);
  const index = Number(raw.index);
  if (
    !Number.isSafeInteger(versionId) ||
    versionId <= 0 ||
    !Number.isSafeInteger(index) ||
    index < 0
  ) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const token = req.nextUrl.searchParams.get("token");
  const viaToken =
    !!token && verifyFileToken(versionFileTokenId(versionId, index), token);
  if (!viaToken && !(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const version = await db.query.modelVersions.findFirst({
    where: eq(modelVersions.id, versionId),
  });
  const file = version?.snapshot.files[index];
  if (!file) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Range requests for the same reason as /api/files/[id]: a historical video
  // is played by the same <video> element on the version-preview page.
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

  const headers = new Headers();
  // Same rule as /api/files/[id]: the served type comes from the allowlisted
  // extension, never a stored value (inline text/html would be stored XSS).
  headers.set("Content-Type", contentTypeForFilename(file.filename));
  headers.set("X-Content-Type-Options", "nosniff");
  if (object.ContentLength !== undefined) {
    headers.set("Content-Length", String(object.ContentLength));
  }
  headers.set("Accept-Ranges", "bytes");
  if (range) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${file.size}`);
  }
  headers.set(
    "Content-Disposition",
    `${asAttachment ? "attachment" : "inline"}; filename="${encodeURIComponent(file.filename)}"`,
  );
  // Snapshots are immutable, so the caching story matches /api/files/[id]:
  // token-keyed gallery responses may be cached publicly, everything else
  // stays private.
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
