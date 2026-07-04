import { NextRequest, NextResponse } from "next/server";
import { MODEL_EXTENSIONS, IMAGE_EXTENSIONS, fileExtension } from "@/lib/s3";
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

  const contentType = req.headers.get("content-type") || "application/octet-stream";
  const staged = await stageStream(filename, req.body, contentType);

  return NextResponse.json({ ...staged, kind });
}
