// Pure filename/extension logic, split out from s3.ts so it can be unit
// tested without pulling in the S3 client (which reads env vars at import
// time — see AGENTS.md's testing conventions).

// 3mf is the primary format: a container with embedded metadata/images, which
// keeps the upload UI and ingestion simple (stl support was deliberately
// removed). step exists for the Onshape integration, whose exports are STEP
// files; the upload UI still only offers .3mf.
export const MODEL_EXTENSIONS = [".3mf", ".step", ".stp"];
export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
// Optional documents attached to a model (build instructions, manual, …)
export const PDF_EXTENSIONS = [".pdf"];

export function allowedExtensions(kind: "model" | "image" | "pdf") {
  return kind === "model"
    ? MODEL_EXTENSIONS
    : kind === "pdf"
      ? PDF_EXTENSIONS
      : IMAGE_EXTENSIONS;
}

export function fileExtension(filename: string) {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

// Content types are always derived from the (allowlisted) extension — never
// from a client-supplied header or value. /api/files serves images inline on
// our origin, so a stored type of e.g. text/html would be stored XSS.
const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  ".3mf": "model/3mf",
  ".step": "model/step",
  ".stp": "model/step",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
};

export function contentTypeForFilename(filename: string): string {
  return EXTENSION_CONTENT_TYPES[fileExtension(filename)] ?? "application/octet-stream";
}

// Applied when a user renames an already-uploaded file. Always keeps the
// original extension, so a crafted rename can't change what kind a file is
// treated as (allowedExtensions/sliceEligible both key off the extension)
// even though the request only carries a filename string.
export function sanitizeRename(originalFilename: string, proposed: string): string {
  const ext = fileExtension(originalFilename);
  const trimmed = proposed.trim().slice(0, 255);
  if (!trimmed) return originalFilename;
  const base =
    ext && trimmed.toLowerCase().endsWith(ext)
      ? trimmed.slice(0, trimmed.length - ext.length)
      : trimmed;
  const cleanBase = base.trim();
  return cleanBase ? `${cleanBase}${ext}` : originalFilename;
}
