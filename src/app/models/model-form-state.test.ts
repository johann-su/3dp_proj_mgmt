import { test } from "node:test";
import assert from "node:assert/strict";
import type { UploadedFile } from "@/app/models/actions";
import type { SliceStatus } from "@/db/schema";
import {
  buildUpdateFileOrders,
  formIsDirty,
  isQueuedForSlicing,
  mediaFromInitial,
  mediaImages,
  mediaVideos,
  mergeTags,
  orderFilesForCreate,
  skippedSliceKeys,
  splitExtension,
  toggleSliceQueue,
  videoEntry,
  type ExistingFile,
  type ImageEntry,
  type ModelFileEntry,
  type ModelFormInitial,
  type ModelFormValues,
} from "@/app/models/model-form-state";
import { parseYouTubeUrl } from "@/lib/video";

function uploadedFile(kind: UploadedFile["kind"], filename: string): UploadedFile {
  return {
    key: `uploads/00000000-0000-0000-0000-000000000000/${filename}`,
    filename,
    size: 10,
    contentType: "application/octet-stream",
    kind,
  };
}

function existingFile(
  id: string,
  kind: ExistingFile["kind"],
  filename: string,
): ExistingFile {
  return { id, kind, filename, size: 10, imported: false };
}

function existingModelEntry(
  id: string,
  filename: string,
  sliceStatus?: SliceStatus | null,
): ModelFileEntry {
  return {
    key: id,
    type: "existing",
    id,
    imported: false,
    filename,
    size: 10,
    sliceStatus,
  };
}

function newModelEntry(filename: string): ModelFileEntry {
  return {
    key: `new-${filename}`,
    type: "new",
    file: new File(["x"], filename),
    filename,
    size: 10,
  };
}

function existingImageEntry(id: string): ImageEntry {
  return {
    key: id,
    type: "existing",
    id,
    src: `/api/files/${id}`,
    filename: `${id}.png`,
    size: 10,
  };
}

function newImageEntryFixture(filename: string): ImageEntry {
  return {
    key: `new-${filename}`,
    type: "new",
    file: new File(["x"], filename),
    src: `blob:${filename}`,
    filename,
    size: 10,
  };
}

test("splitExtension keeps dotfiles whole and splits at the last dot", () => {
  // Renaming edits only the base name; a dotfile has no extension to preserve.
  assert.deepEqual(splitExtension(".gitignore"), [".gitignore", ""]);
  assert.deepEqual(splitExtension("part.v2.3mf"), ["part.v2", ".3mf"]);
  assert.deepEqual(splitExtension("README"), ["README", ""]);
});

test("mergeTags dedupes case-insensitively", () => {
  // A .3mf's printer tag must not duplicate one the user already typed.
  assert.equal(mergeTags("Bambu A1, PLA", "bambu a1"), "Bambu A1, PLA");
  assert.equal(mergeTags("Bambu A1", "PLA"), "Bambu A1, PLA");
  assert.equal(mergeTags("", "PLA"), "PLA");
});

// Baseline for the dirty tests: an edit view opened and left untouched. The
// gallery holds two images with a video sitting between them, which is the
// arrangement the media list exists to preserve.
const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const VIDEO_ENTRY = videoEntry(VIDEO, parseYouTubeUrl(VIDEO)!);

function pristineEditState(): { current: ModelFormValues; initial: ModelFormInitial } {
  const initial: ModelFormInitial = {
    id: "m",
    title: "Clip",
    description: "desc",
    categoryId: "cat",
    tags: ["pla"],
    bom: [],
    files: [
      existingFile("f1", "model", "clip.3mf"),
      existingFile("i1", "image", "i1.png"),
      existingFile("i2", "image", "i2.png"),
      existingFile("p1", "pdf", "manual.pdf"),
    ],
    videos: [{ url: VIDEO, position: 1 }],
    createdAt: new Date(0),
  };
  const current: ModelFormValues = {
    title: "Clip",
    description: "desc",
    categoryId: "cat",
    tags: "pla",
    bom: [],
    modelFileEntries: [existingModelEntry("f1", "clip.3mf")],
    media: [existingImageEntry("i1"), VIDEO_ENTRY, existingImageEntry("i2")],
    pdfFiles: [],
    existingPdfFiles: [existingFile("p1", "pdf", "manual.pdf")],
    sliceOverrides: {},
  };
  return { current, initial };
}

test("formIsDirty: a pristine edit view is clean, create mode is always dirty", () => {
  const { current, initial } = pristineEditState();
  assert.equal(formIsDirty(current, initial), false);
  // No baseline to compare against → any exit counts as a discard.
  assert.equal(formIsDirty(current, undefined), true);
});

test("formIsDirty: renaming an existing file reads as dirty", () => {
  const { current, initial } = pristineEditState();
  current.modelFileEntries = [existingModelEntry("f1", "renamed.3mf")];
  assert.equal(formIsDirty(current, initial), true);
});

test("formIsDirty: reordering images reads as dirty (first image is the cover)", () => {
  const { current, initial } = pristineEditState();
  current.media = [existingImageEntry("i2"), VIDEO_ENTRY, existingImageEntry("i1")];
  assert.equal(formIsDirty(current, initial), true);
});

// Videos live on the model row, not in the file lists — leaving without saving
// would drop an added or removed link just as silently as a removed image.
test("formIsDirty: adding or removing a gallery video reads as dirty", () => {
  const { current, initial } = pristineEditState();
  const other = "https://www.youtube.com/watch?v=aBcDeFgHiJk";
  current.media = [...current.media, videoEntry(other, parseYouTubeUrl(other)!)];
  assert.equal(formIsDirty(current, initial), true);

  const cleared = pristineEditState();
  cleared.current.media = cleared.current.media.filter((e) => e.type !== "video");
  assert.equal(formIsDirty(cleared.current, cleared.initial), true);
});

// Neither list changed on its own — only the video's slot among the images
// did, and that slot is what gets saved as its position.
test("formIsDirty: moving a video between images reads as dirty", () => {
  const { current, initial } = pristineEditState();
  current.media = [existingImageEntry("i1"), existingImageEntry("i2"), VIDEO_ENTRY];
  assert.equal(formIsDirty(current, initial), true);
});

// What the save actually writes: images keep their own relative order, and
// each video's index in the media list is the position stored with it.
test("mediaImages/mediaVideos split the one list back into what each save needs", () => {
  const media = [existingImageEntry("i1"), VIDEO_ENTRY, existingImageEntry("i2")];
  assert.deepEqual(
    mediaImages(media).map((image) => image.key),
    ["i1", "i2"],
  );
  assert.deepEqual(mediaVideos(media), [{ url: VIDEO, position: 1 }]);
});

// Reopening the edit form has to rebuild exactly the list the last save
// flattened — otherwise a no-op edit would silently reshuffle the gallery.
test("mediaFromInitial rebuilds the saved arrangement", () => {
  const media = mediaFromInitial(
    [existingImageEntry("i1"), existingImageEntry("i2")],
    [{ url: VIDEO, position: 1 }],
  );
  assert.deepEqual(
    media.map((entry) => entry.key),
    ["i1", "dQw4w9WgXcQ", "i2"],
  );
});

test("buildUpdateFileOrders: newIndex counter skips the PDF block", () => {
  // Uploads are ordered model files, then PDFs, then images — image
  // newIndex values must land past the PDFs.
  const { modelFileOrder, imageOrder } = buildUpdateFileOrders(
    [newModelEntry("a.3mf"), existingModelEntry("f1", "clip.3mf")],
    2,
    [existingImageEntry("i1"), newImageEntryFixture("shot.png")],
  );
  assert.deepEqual(modelFileOrder, [{ newIndex: 0 }, { existingId: "f1" }]);
  assert.deepEqual(imageOrder, [{ existingId: "i1" }, { newIndex: 3 }]);
});

test("orderFilesForCreate interleaves staged and new files in arranged order", () => {
  const stagedModel = uploadedFile("model", "imported.3mf");
  const stagedImage = uploadedFile("image", "imported.png");
  const stagedPdf = uploadedFile("pdf", "imported.pdf");
  const uploadedModel = uploadedFile("model", "local.3mf");
  const uploadedPdf = uploadedFile("pdf", "local.pdf");
  const uploadedImage = uploadedFile("image", "local.png");

  const files = orderFilesForCreate(
    // Arranged: the freshly picked model file before the imported one.
    [
      { ...newModelEntry("local.3mf") },
      { key: "s", type: "staged", staged: stagedModel, filename: "imported.3mf", size: 10 },
    ],
    // Arranged: imported image demoted behind the new cover shot.
    [
      newImageEntryFixture("local.png"),
      { key: "si", type: "staged", staged: stagedImage, src: "x", filename: "imported.png", size: 10 },
    ],
    [stagedPdf],
    // Upload order is fixed (models, PDFs, images) regardless of arrangement.
    [uploadedModel, uploadedPdf, uploadedImage],
  );

  assert.deepEqual(
    files.map((f) => f.filename),
    ["local.3mf", "imported.3mf", "imported.pdf", "local.pdf", "local.png", "imported.png"],
  );
});

// The two sides of the wizard want opposite defaults: a file being added is
// sliced (that's what an upload does), one already on the model is not — its
// estimates exist, so re-slicing is a deliberate ask.
test("isQueuedForSlicing: new .3mf files default in, stored ones default out", () => {
  assert.equal(isQueuedForSlicing(newModelEntry("a.3mf"), {}), true);
  assert.equal(isQueuedForSlicing(existingModelEntry("f1", "clip.3mf"), {}), false);
  // Only .3mf reaches the slicer at all (a .scad is rendered, not sliced).
  assert.equal(isQueuedForSlicing(newModelEntry("part.scad"), {}), false);
  // Already handed over by an earlier save — the toggle can't call that back.
  assert.equal(
    isQueuedForSlicing(existingModelEntry("f1", "clip.3mf", "pending"), {
      f1: false,
    }),
    true,
  );
});

// Overrides record only what differs from the default, so toggling twice
// leaves no trace — otherwise an untouched form would prompt "discard changes?"
test("toggleSliceQueue: flipping back to the default clears the override", () => {
  const existing = existingModelEntry("f1", "clip.3mf");
  const queued = toggleSliceQueue({}, existing);
  assert.deepEqual(queued, { f1: true });
  assert.deepEqual(toggleSliceQueue(queued, existing), {});

  const added = newModelEntry("a.3mf");
  const skipped = toggleSliceQueue({}, added);
  assert.deepEqual(skipped, { [added.key]: false });
  assert.deepEqual(toggleSliceQueue(skipped, added), {});
});

// The skip list is keyed by S3 key, which a new file only gets at upload time:
// the entries and the uploads are matched by walking both in wizard order (as
// orderFilesForCreate does), so an unqueued file must not shift the pairing.
test("skippedSliceKeys pairs unqueued entries with their uploaded keys", () => {
  const stagedModel = uploadedFile("model", "imported.3mf");
  const firstUpload = uploadedFile("model", "one.3mf");
  const secondUpload = uploadedFile("model", "two.3mf");
  const one = newModelEntry("one.3mf");
  const two = newModelEntry("two.3mf");
  const entries: ModelFileEntry[] = [
    one,
    { key: "s", type: "staged", staged: stagedModel, filename: "imported.3mf", size: 10 },
    two,
    existingModelEntry("f1", "clip.3mf"),
  ];

  // Untouched: every file being added is sliced, nothing to skip.
  assert.deepEqual(skippedSliceKeys(entries, {}, [firstUpload, secondUpload]), []);
  // The second new file and the imported one taken out of the queue.
  assert.deepEqual(
    skippedSliceKeys(entries, { [two.key]: false, s: false }, [
      firstUpload,
      secondUpload,
    ]),
    [stagedModel.key, secondUpload.key],
  );
  // Queueing a file already on the model is an id, not a key — it belongs to
  // resliceFileIds and must stay out of the skip list.
  assert.deepEqual(
    skippedSliceKeys(entries, { f1: true }, [firstUpload, secondUpload]),
    [],
  );
});
