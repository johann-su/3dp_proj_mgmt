import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSession } from "@/lib/auth";
import {
  s3,
  S3_BUCKET,
  contentTypeForFilename,
  fileExtension,
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
} from "@/lib/s3";

export const runtime = "nodejs";

// Serves staged gallery media ("uploads/…") so the create form can show
// thumbnails — and play videos — for files imported by URL before the model
// exists. Images and videos only: staged keys are unguessable UUIDs, but this
// must not become a general S3 proxy.
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const key = req.nextUrl.searchParams.get("key") ?? "";
  if (
    !/^uploads\/[0-9a-f-]{36}\/[a-zA-Z0-9._-]+$/.test(key) ||
    !(
      IMAGE_EXTENSIONS.includes(fileExtension(key)) ||
      VIDEO_EXTENSIONS.includes(fileExtension(key))
    )
  ) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let object;
  try {
    object = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!object.Body) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const headers = new Headers();
  // The key's extension is allowlisted above, so derive the type from it
  // rather than trusting whatever ContentType the object was staged with.
  headers.set("Content-Type", contentTypeForFilename(key));
  headers.set("X-Content-Type-Options", "nosniff");
  if (object.ContentLength !== undefined) {
    headers.set("Content-Length", String(object.ContentLength));
  }
  headers.set("Content-Disposition", "inline");
  headers.set("Cache-Control", "private, max-age=3600");

  return new Response(object.Body.transformToWebStream(), { headers });
}
