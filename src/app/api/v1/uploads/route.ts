import { apiJson, invalidRequest } from "@/lib/api/http";
import { apiRoute } from "@/lib/api/route";
import { signUploadToken, uploadTokenKey } from "@/lib/api/upload-token";
import { contentTypeForFilename, fileKindForFilename } from "@/lib/file-kind";
import { stageStream } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Stages one file — the raw bytes as the body, like POST /api/upload — and answers with an `upload` handle to attach on POST/PATCH /models. Streams straight to storage, so large .3mf files never buffer in memory. Nothing is added to the catalog until a model references the handle.
export const POST = apiRoute("files:write", async ({ request, principal }) => {
  const filename = request.nextUrl.searchParams.get("filename")?.trim();
  if (!filename || filename.length > 255 || /[\\/]/.test(filename)) {
    return invalidRequest("?filename= is required (a bare file name, at most 255 characters)");
  }
  // The kind follows from the extension (the allowlists don't overlap); an explicit ?kind= must agree with it.
  const kind = fileKindForFilename(filename);
  if (!kind) return invalidRequest(`File type not allowed: ${filename}`);
  const claimed = request.nextUrl.searchParams.get("kind");
  if (claimed && claimed !== kind) {
    return invalidRequest(`${filename} is a ${kind} file, not ${claimed}`);
  }
  if (!request.body) return invalidRequest("Send the file's bytes as the request body");

  // The served type comes from the validated extension, never the request's Content-Type — see /api/upload.
  const staged = await stageStream(filename, request.body, contentTypeForFilename(filename));
  if (staged.size === 0) return invalidRequest("The uploaded file is empty");

  const { token, expiresAt } = signUploadToken(
    {
      key: staged.key,
      filename: staged.filename,
      size: staged.size,
      kind,
      contentHash: staged.contentHash,
    },
    principal.user.id,
    uploadTokenKey(),
  );
  return apiJson(
    {
      upload: token,
      filename: staged.filename,
      size: staged.size,
      kind,
      expiresAt: expiresAt.toISOString(),
    },
    { status: 201 },
  );
});
