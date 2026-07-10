import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { modelFiles } from "@/db/schema";
import { s3, S3_BUCKET } from "@/lib/s3";

export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const file = await db.query.modelFiles.findFirst({
    where: eq(modelFiles.id, id),
  });
  if (!file) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const object = await s3.send(
    new GetObjectCommand({ Bucket: S3_BUCKET, Key: file.s3Key }),
  );
  if (!object.Body) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const asAttachment =
    file.kind === "model" || req.nextUrl.searchParams.get("download") === "1";

  const headers = new Headers();
  headers.set("Content-Type", file.contentType);
  if (object.ContentLength !== undefined) {
    headers.set("Content-Length", String(object.ContentLength));
  }
  headers.set(
    "Content-Disposition",
    `${asAttachment ? "attachment" : "inline"}; filename="${encodeURIComponent(file.filename)}"`,
  );
  // Files are content-addressed by an immutable UUID, so an image never changes
  // under a given URL — let the browser and the next/image optimizer cache it
  // aggressively (the optimizer's TTL is max(minimumCacheTTL, upstream max-age)).
  // Non-image files stay short-lived + private since they're download payloads.
  headers.set(
    "Cache-Control",
    file.kind === "image"
      ? "public, max-age=31536000, immutable"
      : "private, max-age=3600",
  );

  return new Response(object.Body.transformToWebStream(), { headers });
}
