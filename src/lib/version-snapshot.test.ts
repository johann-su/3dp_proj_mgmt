import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelVersionSnapshot, VersionFileSnapshot } from "@/db/schema";
import {
  buildSnapshot,
  snapshotsEqual,
  summarizeVersionChange,
} from "@/lib/version-snapshot";

function file(overrides: Partial<VersionFileSnapshot> = {}): VersionFileSnapshot {
  return {
    kind: "model",
    filename: "part.3mf",
    s3Key: "uploads/aaaaaaaa-0000-0000-0000-000000000000/part.3mf",
    size: 1024,
    contentType: "model/3mf",
    animated: false,
    onshapeElementId: null,
    imported: false,
    sourceFileId: null,
    sourceModifiedAt: null,
    contentHash: null,
    sliceStatus: null,
    sliceSource: null,
    printTimeSeconds: null,
    filamentGrams: null,
    sliceError: null,
    printerInfo: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<ModelVersionSnapshot> = {}): ModelVersionSnapshot {
  return {
    title: "Talon 1400",
    description: "A glider",
    categoryId: "cat-1",
    tags: ["glider", "rc"],
    bom: [],
    videos: [],
    files: [file()],
    ...overrides,
  };
}

test("buildSnapshot excludes generated variants and sorts tag names", () => {
  // The snapshot is the model's live, non-variant state; variants are additive
  // and individually regenerable, and tags have no join order.
  const snap = buildSnapshot({
    title: "Talon 1400",
    description: "A glider",
    categoryId: "cat-1",
    videos: [],
    modelTags: [{ tag: { name: "rc" } }, { tag: { name: "glider" } }],
    bomItems: [
      { name: "M3 screw", quantity: "4", link: null, imageUrl: null, section: null },
    ],
    files: [
      // Import provenance must survive the snapshot so a revert restores the
      // "imported" badge along with the file row.
      { ...file({ filename: "wing.3mf", imported: true }), generatedFromId: null },
      // A generated .3mf variant — must not appear in the snapshot.
      { ...file({ s3Key: "uploads/v/variant.3mf" }), generatedFromId: "src-1" },
    ],
  });
  assert.deepEqual(snap.tags, ["glider", "rc"]);
  assert.equal(snap.files.length, 1);
  assert.equal(snap.files[0].filename, "wing.3mf");
  assert.equal(snap.files[0].imported, true);
});

test("snapshotsEqual detects identical state so no-op saves write no version", () => {
  assert.equal(snapshotsEqual(snapshot(), snapshot()), true);
  assert.equal(
    snapshotsEqual(snapshot(), snapshot({ title: "Renamed" })),
    false,
  );
});

test("initial version summary counts files and BOM items", () => {
  const next = snapshot({
    files: [file(), file({ s3Key: "uploads/b/img.png", kind: "image" })],
    bom: [{ name: "M3 screw", quantity: "4", link: null, imageUrl: null, section: null }],
  });
  assert.equal(summarizeVersionChange(null, next), "2 files, 1 BOM item");
});

test("files are identified by s3Key: a new filename on the same key is a rename, not remove+add", () => {
  const prev = snapshot();
  const next = snapshot({
    files: [file({ filename: "wing.3mf" })],
  });
  assert.equal(summarizeVersionChange(prev, next), "1 file renamed");
});

test("added and removed files are counted by key difference", () => {
  const prev = snapshot({ files: [file(), file({ s3Key: "uploads/b/old.3mf" })] });
  const next = snapshot({ files: [file(), file({ s3Key: "uploads/c/new.3mf" })] });
  assert.equal(summarizeVersionChange(prev, next), "1 file added, 1 file removed");
});

test("field edits combine into one summary line", () => {
  const prev = snapshot();
  const next = snapshot({ title: "Talon 1400 v2", tags: ["glider"] });
  assert.equal(
    summarizeVersionChange(prev, next),
    "renamed to “Talon 1400 v2”, tags updated",
  );
});

// Snapshots written before gallery videos existed have no `videos` key at
// all; reading one as [] keeps the first save after the upgrade from claiming
// a video change nobody made.
test("gallery video changes are summarized, and a missing key reads as none", () => {
  const prev = snapshot();
  const next = snapshot({
    videos: [{ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", position: 1 }],
  });
  assert.equal(summarizeVersionChange(prev, next), "videos updated");

  const legacy = snapshot();
  delete (legacy as Partial<ModelVersionSnapshot>).videos;
  assert.equal(summarizeVersionChange(legacy, snapshot()), "file details updated");
});

test("same file set with changed metadata degrades to a generic summary", () => {
  // Slice estimates landing between two saves change per-file metadata
  // without any user-visible edit — the summary must not claim file changes.
  const prev = snapshot();
  const next = snapshot({
    files: [file({ sliceStatus: "ok", printTimeSeconds: 5460 })],
  });
  assert.equal(summarizeVersionChange(prev, next), "file details updated");
});
