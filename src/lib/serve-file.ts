import { NextRequest, NextResponse, after } from "next/server";
import type { modelFiles } from "@/db/schema";
import { contentTypeForFilename } from "@/lib/file-kind";
import { incrementFileDownloadCount } from "@/lib/metrics";
import { parseByteRange } from "@/lib/http-range";
import { blobStore } from "@/lib/storage";

// Streams a model_files row to the client — the part of the file routes that
// is the same whoever is asking. Access control is the *caller's* job:
// /api/files/[id] (session or file token) and /api/files/shared/[fileId]
// (public share link) each authorize before handing the row here, and pick
// the Cache-Control that fits their credential.
export async function serveModelFile(
  req: NextRequest,
  file: typeof modelFiles.$inferSelect,
  { cacheControl, extraHeaders }: { cacheControl: string; extraHeaders?: Record<string, string> },
): Promise<Response> {
  // Seeking a video sends a Range header; answer it with 206 + Content-Range
  // rather than the whole object (Safari won't play a source that doesn't).
  const range = parseByteRange(req.headers.get("range"), file.size);
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${file.size}` },
    });
  }

  const object = await blobStore().get(file.s3Key, range ?? undefined);
  if (!object) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const asAttachment =
    file.kind === "model" || req.nextUrl.searchParams.get("download") === "1";
  // Only count real downloads, not inline image views (gallery thumbnails,
  // the next/image optimizer) — and not each of the many range requests a
  // video player makes while scrubbing.
  if (asAttachment && !range) after(() => incrementFileDownloadCount(file.id));

  const headers = new Headers(extraHeaders);
  // Content type comes from the allowlisted extension, not the stored value:
  // the stored one originally echoed the uploader's header, and serving an
  // attacker-chosen type inline (text/html) on our origin would be stored XSS.
  headers.set("Content-Type", contentTypeForFilename(file.filename));
  headers.set("X-Content-Type-Options", "nosniff");
  if (object.contentLength !== undefined) {
    headers.set("Content-Length", String(object.contentLength));
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
  headers.set("Cache-Control", cacheControl);

  return new Response(object.stream, {
    status: range ? 206 : 200,
    headers,
  });
}
