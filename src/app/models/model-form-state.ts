// The create/edit wizard's data model: the entry types the pickers render,
// plus the pure logic that is easy to get subtly wrong — dirty detection and
// the file-order bookkeeping handed to the create/update actions. Kept free
// of React so it stays unit-testable (see model-form-state.test.ts).

import type { FileOrderRef, UploadedFile } from "@/app/models/actions";
import type { SliceStatus } from "@/db/schema";
import type { BomItemInput } from "@/lib/bom";
import {
  orderGalleryItems,
  parseYouTubeUrl,
  type ModelVideo,
  type YouTubeVideo,
} from "@/lib/video";

export const MODEL_ACCEPT = ".3mf,.scad";
export const IMAGE_ACCEPT = ".png,.jpg,.jpeg,.webp,.gif";
export const PDF_ACCEPT = ".pdf";

export type ExistingFile = {
  id: string;
  filename: string;
  size: number;
  kind: "model" | "image" | "pdf";
  // Came with the model's source-platform import (model_files.imported) —
  // keeps the cloud badge visible in edit mode.
  imported: boolean;
  // Only meaningful for .3mf model files: "pending" means the slicer is
  // already queued to look at it, so the re-slice control has nothing to add.
  sliceStatus?: SliceStatus | null;
};

// Prefilled values when editing; absent when creating a new model.
export type ModelFormInitial = {
  id: string;
  title: string;
  description: string;
  categoryId: string | null;
  tags: string[];
  bom: BomItemInput[];
  files: ExistingFile[];
  // Gallery videos with their slots in the combined order (models.videos).
  videos: ModelVideo[];
  createdAt: Date;
};

// One image in the wizard, in display order: already stored on the model
// (edit mode), staged in S3 by a URL import (create mode), or freshly
// picked (src is an object URL then).
export type ImageEntry = {
  key: string;
  src: string;
  filename: string;
  size: number;
} & (
  | { type: "existing"; id: string }
  | { type: "staged"; staged: UploadedFile }
  | { type: "new"; file: File }
);

export function newImageEntry(file: File): ImageEntry {
  return {
    key: crypto.randomUUID(),
    type: "new",
    file,
    src: URL.createObjectURL(file),
    filename: file.name,
    size: file.size,
  };
}

export function stagedImageEntry(file: UploadedFile): ImageEntry {
  return {
    key: file.key,
    type: "staged",
    staged: file,
    src: `/api/uploads/preview?key=${encodeURIComponent(file.key)}`,
    filename: file.filename,
    size: file.size,
  };
}

// A gallery video in the wizard. It sits in the same list as the images
// because the gallery is one sequence — dragging a video between two images is
// the whole point — but it has no file behind it, only the link.
export type VideoEntry = {
  key: string;
  type: "video";
  // Canonical watch URL, as stored (see canonicalYouTubeUrl).
  url: string;
  video: YouTubeVideo;
};

export function videoEntry(url: string, video: YouTubeVideo): VideoEntry {
  // Keyed by video id: the same video can't appear twice in one gallery, so
  // the id is stable across reorders in a way a random key wouldn't be.
  return { key: video.id, type: "video", url, video };
}

// One slot in the gallery, as the media picker renders it.
export type MediaEntry = ImageEntry | VideoEntry;

export function isVideoEntry(entry: MediaEntry): entry is VideoEntry {
  return entry.type === "video";
}

export function mediaImages(media: MediaEntry[]): ImageEntry[] {
  return media.filter((entry): entry is ImageEntry => entry.type !== "video");
}

// The stored form of the wizard's videos: each one's index in the media list
// *is* its position in the combined gallery order.
export function mediaVideos(media: MediaEntry[]): ModelVideo[] {
  return media.flatMap((entry, position) =>
    entry.type === "video" ? [{ url: entry.url, position }] : [],
  );
}

// The media list a saved model reopens with: its images and videos woven back
// into the one order the gallery shows them in.
export function mediaFromInitial(
  images: ImageEntry[],
  videos: ModelVideo[],
): MediaEntry[] {
  return orderGalleryItems(images, videos).flatMap<MediaEntry>((entry) => {
    if (entry.kind === "image") return [entry.item];
    const video = parseYouTubeUrl(entry.item.url);
    // A stored link we can't parse has no tile to render — the same rule the
    // gallery applies.
    return video ? [videoEntry(entry.item.url, video)] : [];
  });
}

// One model (.3mf/.step) file in the wizard, in display order: already
// stored on the model (edit mode), staged in S3 by a URL import (create
// mode), or freshly picked. Mirrors ImageEntry so the same reorder mechanics
// (drag + move buttons) apply.
export type ModelFileEntry = {
  key: string;
  filename: string;
  size: number;
} & (
  | {
      type: "existing";
      id: string;
      imported: boolean;
      sliceStatus?: SliceStatus | null;
    }
  | { type: "staged"; staged: UploadedFile }
  | { type: "new"; file: File }
);

export function newModelFileEntry(file: File): ModelFileEntry {
  return {
    key: crypto.randomUUID(),
    type: "new",
    file,
    filename: file.name,
    size: file.size,
  };
}

export function stagedModelFileEntry(file: UploadedFile): ModelFileEntry {
  return {
    key: file.key,
    type: "staged",
    staged: file,
    filename: file.filename,
    size: file.size,
  };
}

// A model/pdf file picked in the browser but not yet uploaded. Carries a
// stable key (for React lists, and so a rename can target one entry) and an
// editable display name independent of the underlying File's read-only name.
export type PendingFile = { key: string; file: File; name: string };

export function pendingFile(file: File): PendingFile {
  return { key: crypto.randomUUID(), file, name: file.name };
}

// A name has no extension to preserve if there's no dot, or the dot is the
// first character (a dotfile like ".gitignore").
export function splitExtension(name: string): [base: string, ext: string] {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? [name, ""] : [name.slice(0, dot), name.slice(dot)];
}

export function mergeTags(existing: string, addition: string) {
  const current = existing
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (current.some((t) => t.toLowerCase() === addition.toLowerCase())) {
    return existing;
  }
  return [...current, addition].join(", ");
}

export async function uploadFile(
  file: File,
  kind: "model" | "image" | "pdf",
  filename: string = file.name,
): Promise<UploadedFile> {
  const params = new URLSearchParams({ filename, kind });
  const res = await fetch(`/api/upload?${params}`, {
    method: "POST",
    body: file,
    headers: { "Content-Type": file.type || "application/octet-stream" },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Upload failed for ${filename}`);
  }
  return res.json();
}

export type ModelFormValues = {
  title: string;
  description: string;
  categoryId: string;
  // The raw comma-separated tags input value.
  tags: string;
  bom: BomItemInput[];
  modelFileEntries: ModelFileEntry[];
  // Images and videos in one list — the gallery's display order.
  media: MediaEntry[];
  pdfFiles: PendingFile[];
  existingPdfFiles: ExistingFile[];
  // Only the .3mf entries whose slice queueing the user flipped away from the
  // default (keyed by ModelFileEntry.key) — see isQueuedForSlicing.
  sliceOverrides: Record<string, boolean>;
};

// Whether the form differs from what was loaded. In create mode there is no
// baseline, so any exit is treated as a discard (unchanged behaviour); in
// edit mode we compare every editable field/file list against `initial` so a
// pristine edit view leaves without a prompt.
export function formIsDirty(
  current: ModelFormValues,
  initial: ModelFormInitial | undefined,
): boolean {
  if (!initial) return true;
  // Slice queueing is applied by the save, so leaving without saving would
  // silently drop it — that counts as an unsaved change. The map only holds
  // entries that differ from the default, so toggling back clears it.
  if (Object.keys(current.sliceOverrides).length > 0) return true;
  if (current.title !== initial.title) return true;
  if (current.description !== initial.description) return true;
  if (current.categoryId !== (initial.categoryId ?? "")) return true;

  const currentTags = current.tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (
    currentTags.length !== initial.tags.length ||
    currentTags.some((t, i) => t !== initial.tags[i])
  )
    return true;

  if (JSON.stringify(current.bom) !== JSON.stringify(initial.bom)) return true;

  // Model files: a " new" marker for freshly added entries (can't collide —
  // existing markers always contain a ":"), otherwise the id + filename, so
  // adds, removes, reorders and renames all read as dirty.
  const curModel = current.modelFileEntries.map((e) =>
    e.type === "existing" ? `${e.id}:${e.filename}` : " new",
  );
  const initModel = initial.files
    .filter((f) => f.kind === "model")
    .map((f) => `${f.id}:${f.filename}`);
  if (
    curModel.length !== initModel.length ||
    curModel.some((v, i) => v !== initModel[i])
  )
    return true;

  // The gallery as one sequence: images (no rename, but order matters — the
  // first image is the cover) and videos (canonicalized on save, so the URL
  // compares directly). Marking each entry by kind means moving a video across
  // an image reads as dirty too, even though neither list changed on its own.
  const curMedia = current.media.map((entry) =>
    entry.type === "video"
      ? `v:${entry.url}`
      : entry.type === "existing"
        ? `i:${entry.id}`
        : " new",
  );
  const initMedia = mediaFromInitial(
    initial.files
      .filter((f) => f.kind === "image")
      .map((f) => ({
        key: f.id,
        type: "existing" as const,
        id: f.id,
        src: "",
        filename: f.filename,
        size: f.size,
      })),
    initial.videos,
  ).map((entry) => (entry.type === "video" ? `v:${entry.url}` : `i:${entry.key}`));
  if (
    curMedia.length !== initMedia.length ||
    curMedia.some((v, i) => v !== initMedia[i])
  )
    return true;

  // PDFs: any freshly picked file, or a removed existing one.
  if (current.pdfFiles.length > 0) return true;
  const initPdf = initial.files.filter((f) => f.kind === "pdf");
  if (current.existingPdfFiles.length !== initPdf.length) return true;

  return false;
}

// --- Slice queueing -------------------------------------------------------
//
// Every .3mf row carries a toggle for handing the file to the slicer when the
// form is saved. The two sides of the form want opposite defaults, so the
// state is stored as *overrides* of the default rather than a plain list:
// that keeps the map empty for an untouched form (so it doesn't read as
// dirty) and lets a toggle-and-toggle-back leave no trace.

// Only .3mf files carry the geometry and embedded settings the slicer reads —
// mirrors sliceEligible in @/lib/slicer, which a client component can't import
// (it builds an S3 client at load time).
function isSliceable(entry: ModelFileEntry): boolean {
  return entry.filename.toLowerCase().endsWith(".3mf");
}

// A file being added is sliced by default (that's what an upload does anyway);
// one already on the model is not — its estimates exist, so re-slicing is the
// opt-in that backfills newly parsed fields or retries a failure.
export function defaultQueuedForSlicing(entry: ModelFileEntry): boolean {
  return isSliceable(entry) && entry.type !== "existing";
}

export function isQueuedForSlicing(
  entry: ModelFileEntry,
  overrides: Record<string, boolean>,
): boolean {
  if (!isSliceable(entry)) return false;
  // Handed over by an earlier save and not finished yet. The toggle can't call
  // that back, so it reads as queued whatever the override says.
  if (entry.type === "existing" && entry.sliceStatus === "pending") return true;
  return overrides[entry.key] ?? defaultQueuedForSlicing(entry);
}

export function toggleSliceQueue(
  overrides: Record<string, boolean>,
  entry: ModelFileEntry,
): Record<string, boolean> {
  const next = !isQueuedForSlicing(entry, overrides);
  // Back to the default → drop the entry, so an untouched form stays clean.
  const rest = { ...overrides };
  delete rest[entry.key];
  return next === defaultQueuedForSlicing(entry) ? rest : { ...rest, [entry.key]: next };
}

// The S3 keys of files being added that the user took *out* of the queue, for
// createModel/updateModel (which otherwise queue every new .3mf). Walks the
// entries the way orderFilesForCreate does: `uploaded` holds the freshly
// uploaded files in wizard upload order, so consuming the model uploads one by
// one pairs each "new" entry with the key it was stored under.
export function skippedSliceKeys(
  modelFileEntries: ModelFileEntry[],
  overrides: Record<string, boolean>,
  uploaded: UploadedFile[],
): string[] {
  const uploadedModels = uploaded.filter((f) => f.kind === "model");
  let uploadedModelIndex = 0;
  const keys: string[] = [];
  for (const entry of modelFileEntries) {
    const file =
      entry.type === "staged"
        ? entry.staged
        : entry.type === "new"
          ? uploadedModels[uploadedModelIndex++]
          : undefined;
    // Non-.3mf uploads are never queued anyway — leave them out of the list.
    if (file && isSliceable(entry) && !isQueuedForSlicing(entry, overrides)) {
      keys.push(file.key);
    }
  }
  return keys;
}

// Edit mode: per-kind order lists for updateModel. newIndex values are
// indices into the uploaded/newFiles array, which lists new model files
// first, then new PDFs, then new images (the wizard's upload order) — so the
// running counter skips the PDF block between the two lists.
export function buildUpdateFileOrders(
  modelFileEntries: ModelFileEntry[],
  newPdfCount: number,
  images: ImageEntry[],
): { modelFileOrder: FileOrderRef[]; imageOrder: FileOrderRef[] } {
  let uploadIndex = 0;
  const modelFileOrder: FileOrderRef[] = modelFileEntries.map((entry) =>
    entry.type === "existing"
      ? { existingId: entry.id }
      : { newIndex: uploadIndex++ },
  );
  uploadIndex += newPdfCount;
  const imageOrder: FileOrderRef[] = images.map((image) =>
    image.type === "existing"
      ? { existingId: image.id }
      : { newIndex: uploadIndex++ },
  );
  return { modelFileOrder, imageOrder };
}

// Create mode: the flat file list for createModel. Order determines position
// (and the image cover = first image): model files and images each follow
// the order arranged in the wizard (staged and new interleaved), then PDFs.
// `uploaded` holds the freshly uploaded files in wizard upload order (model
// files, then PDFs, then images), so walking the entries and consuming the
// matching kind one by one restores the arrangement.
export function orderFilesForCreate(
  modelFileEntries: ModelFileEntry[],
  images: ImageEntry[],
  stagedPdfFiles: UploadedFile[],
  uploaded: UploadedFile[],
): UploadedFile[] {
  const uploadedModels = uploaded.filter((f) => f.kind === "model");
  const uploadedPdfs = uploaded.filter((f) => f.kind === "pdf");
  const uploadedImages = uploaded.filter((f) => f.kind === "image");

  let uploadedModelIndex = 0;
  const orderedModelFiles: UploadedFile[] = [];
  for (const entry of modelFileEntries) {
    if (entry.type === "staged") orderedModelFiles.push(entry.staged);
    else if (entry.type === "new")
      orderedModelFiles.push(uploadedModels[uploadedModelIndex++]);
  }
  let uploadedImageIndex = 0;
  const orderedImages: UploadedFile[] = [];
  for (const image of images) {
    if (image.type === "staged") orderedImages.push(image.staged);
    else if (image.type === "new")
      orderedImages.push(uploadedImages[uploadedImageIndex++]);
  }
  return [...orderedModelFiles, ...stagedPdfFiles, ...uploadedPdfs, ...orderedImages];
}
