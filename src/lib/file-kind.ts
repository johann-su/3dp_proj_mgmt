// Pure filename/extension logic, split out from s3.ts so it can be unit
// tested without pulling in the S3 client (which reads env vars at import
// time — see AGENTS.md's testing conventions).

// 3mf is the primary format: a container with embedded metadata/images, which
// keeps the upload UI and ingestion simple (stl support was deliberately
// removed). step exists for the Onshape integration, whose exports are STEP
// files. scad is parametric OpenSCAD source — customized .3mf variants are
// rendered from it via the openscad service (see AGENTS.md).
export const MODEL_EXTENSIONS = [".3mf", ".step", ".stp", ".scad"];
export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
// Optional documents attached to a model (build instructions, manual, …)
export const PDF_EXTENSIONS = [".pdf"];
// Gallery videos (a print in motion, an assembly clip). Deliberately only the
// three containers every target browser plays natively — the file is served
// straight to a <video> element, and there is no transcoding step to rescue a
// format the browser refuses. .mov is here because phone cameras produce it;
// its H.264 payload plays in Safari and Chrome, though not Firefox.
export const VIDEO_EXTENSIONS = [".mp4", ".webm", ".mov"];

// Kinds that share the model's one gallery sequence (see GALLERY_KINDS): a
// video dragged between two photos keeps that slot, so they cannot be ordered
// independently of each other.
export const GALLERY_KINDS: ("image" | "video")[] = ["image", "video"];

export function isGalleryKind(kind: string): kind is "image" | "video" {
  return kind === "image" || kind === "video";
}

export function allowedExtensions(kind: "model" | "image" | "pdf" | "video") {
  return kind === "model"
    ? MODEL_EXTENSIONS
    : kind === "pdf"
      ? PDF_EXTENSIONS
      : kind === "video"
        ? VIDEO_EXTENSIONS
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
  // Plain text, but never text/* — /api/files must not serve it inline as
  // something a browser would render (same stored-XSS reasoning as images).
  ".scad": "application/x-openscad",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  // Served inline to a <video> element. Safe to render inline for the same
  // reason images are: a browser never treats video/* as markup.
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

export function contentTypeForFilename(filename: string): string {
  return EXTENSION_CONTENT_TYPES[fileExtension(filename)] ?? "application/octet-stream";
}

// Turns a model title into the base of a download filename (the BOM CSV, the
// export zip). Titles are free text — anything outside the safe set would need
// escaping in the Content-Disposition header.
export function safeFileBase(title: string): string {
  return (
    title.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "model"
  );
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
