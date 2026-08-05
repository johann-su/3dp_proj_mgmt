import { NextRequest, NextResponse } from "next/server";
import { allowedExtensions, contentTypeForFilename, fileExtension } from "@/lib/s3";
import { stageStream } from "@/lib/storage";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const filename = req.nextUrl.searchParams.get("filename");
  const kind = req.nextUrl.searchParams.get("kind");
  if (
    !filename ||
    (kind !== "model" && kind !== "image" && kind !== "pdf" && kind !== "video")
  ) {
    return NextResponse.json(
      { error: "filename and kind (model|image|pdf|video) are required" },
      { status: 400 },
    );
  }

  const ext = fileExtension(filename);
  const allowed = allowedExtensions(kind);
  if (!allowed.includes(ext)) {
    return NextResponse.json(
      { error: `File type ${ext || "(none)"} not allowed. Allowed: ${allowed.join(", ")}` },
      { status: 400 },
    );
  }

  if (!req.body) {
    return NextResponse.json({ error: "Empty request body" }, { status: 400 });
  }

  // Derive the content type from the (validated) extension instead of the
  // request header: /api/files serves images/PDFs inline, so echoing back an
  // uploader-chosen type like text/html would be stored XSS on our origin.
  const staged = await stageStream(
    filename,
    req.body,
    contentTypeForFilename(filename),
  );

  return NextResponse.json({ ...staged, kind });
}
