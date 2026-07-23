import { test } from "node:test";
import assert from "node:assert/strict";
import type { UploadedFile } from "@/app/models/actions";
import {
  buildUpdateFileOrders,
  formIsDirty,
  mergeTags,
  orderFilesForCreate,
  splitExtension,
  type ExistingFile,
  type ImageEntry,
  type ModelFileEntry,
  type ModelFormInitial,
  type ModelFormValues,
} from "@/app/models/model-form-state";

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

function existingModelEntry(id: string, filename: string): ModelFileEntry {
  return {
    key: id,
    type: "existing",
    id,
    imported: false,
    filename,
    size: 10,
    printerInfo: null,
    derivatives: [],
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

// Baseline for the dirty tests: an edit view opened and left untouched.
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
    createdAt: new Date(0),
  };
  const current: ModelFormValues = {
    title: "Clip",
    description: "desc",
    categoryId: "cat",
    tags: "pla",
    bom: [],
    modelFileEntries: [existingModelEntry("f1", "clip.3mf")],
    images: [existingImageEntry("i1"), existingImageEntry("i2")],
    pdfFiles: [],
    existingPdfFiles: [existingFile("p1", "pdf", "manual.pdf")],
  };
  return { current, initial };
}

test("formIsDirty: a pristine edit view is clean, create mode is always dirty", () => {
  const { current, initial } = pristineEditState();
  assert.equal(formIsDirty(current, initial), false);
  // No baseline to compare against → any exit counts as a discard.
  assert.equal(formIsDirty(current, undefined), true);
});

test("formIsDirty ignores generated files (variants, printer derivatives)", () => {
  // Generated files never become wizard entries — they're managed immediately
  // via their own endpoints — so their presence in the loaded model must not
  // make an untouched form read as dirty (issue #79).
  const { current, initial } = pristineEditState();
  initial.files.push({
    ...existingFile("d1", "model", "clip_p1s_04.3mf"),
    generatedFromId: "f1",
  });
  assert.equal(formIsDirty(current, initial), false);
});

test("formIsDirty: renaming an existing file reads as dirty", () => {
  const { current, initial } = pristineEditState();
  current.modelFileEntries = [existingModelEntry("f1", "renamed.3mf")];
  assert.equal(formIsDirty(current, initial), true);
});

test("formIsDirty: reordering images reads as dirty (first image is the cover)", () => {
  const { current, initial } = pristineEditState();
  current.images = [existingImageEntry("i2"), existingImageEntry("i1")];
  assert.equal(formIsDirty(current, initial), true);
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
