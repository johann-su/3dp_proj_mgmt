import { NextRequest, NextResponse } from "next/server";
import { Upload } from "@aws-sdk/lib-storage";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { s3, S3_BUCKET, MODEL_EXTENSIONS, IMAGE_EXTENSIONS, fileExtension } from "@/lib/s3";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const filename = req.nextUrl.searchParams.get("filename");
  const kind = req.nextUrl.searchParams.get("kind");
  if (!filename || (kind !== "model" && kind !== "image")) {
    return NextResponse.json(
      { error: "filename and kind (model|image) are required" },
      { status: 400 },
    );
  }

  const ext = fileExtension(filename);
  const allowed = kind === "model" ? MODEL_EXTENSIONS : IMAGE_EXTENSIONS;
  if (!allowed.includes(ext)) {
    return NextResponse.json(
      { error: `File type ${ext || "(none)"} not allowed. Allowed: ${allowed.join(", ")}` },
      { status: 400 },
    );
  }

  if (!req.body) {
    return NextResponse.json({ error: "Empty request body" }, { status: 400 });
  }

  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const key = `uploads/${randomUUID()}/${safeName}`;
  const contentType = req.headers.get("content-type") || "application/octet-stream";

  const upload = new Upload({
    client: s3,
    params: {
      Bucket: S3_BUCKET,
      Key: key,
      Body: Readable.fromWeb(req.body as unknown as import("node:stream/web").ReadableStream),
      ContentType: contentType,
    },
  });
  await upload.done();

  return NextResponse.json({
    key,
    filename,
    size: Number(req.headers.get("content-length") ?? 0),
    contentType,
    kind,
  });
}
