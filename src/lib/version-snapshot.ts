// Pure helpers over ModelVersionSnapshot (see src/db/schema.ts): equality
// (skip writing no-op versions) and the human-readable one-line change
// summary shown in the model page's History panel. DB-free on purpose —
// src/lib/model-versions.ts does the reading/writing.

import type {
  ModelVersionSnapshot,
  VersionFileSnapshot,
} from "@/db/schema";
import type { BomItemInput } from "@/lib/bom";

// The loaded model shape buildSnapshot maps from — the fields captureSnapshot
// reads (src/lib/model-versions.ts) and the same relations the model page
// already loads, so both can share the pure mapping.
export type SnapshotSource = {
  title: string;
  description: string;
  categoryId: string | null;
  modelTags: { tag: { name: string } }[];
  bomItems: BomItemInput[];
  files: (VersionFileSnapshot & { generatedFromId: string | null })[];
};

// Maps a loaded model into a ModelVersionSnapshot. Pure so both the DB-side
// captureSnapshot and the model page (synthesizing a display-only v1 for
// pre-versioning models) share one definition. The key order is fixed because
// snapshotsEqual compares via JSON; generated OpenSCAD variants are excluded
// (additive, individually deletable) and tag names sorted (the join has no
// order).
export function buildSnapshot(model: SnapshotSource): ModelVersionSnapshot {
  return {
    title: model.title,
    description: model.description,
    categoryId: model.categoryId,
    tags: model.modelTags.map(({ tag }) => tag.name).sort(),
    bom: model.bomItems.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      link: item.link,
      imageUrl: item.imageUrl,
      section: item.section,
    })),
    files: model.files
      .filter((f) => f.generatedFromId === null)
      .map((f) => ({
        kind: f.kind,
        filename: f.filename,
        s3Key: f.s3Key,
        size: f.size,
        contentType: f.contentType,
        animated: f.animated,
        onshapeElementId: f.onshapeElementId,
        imported: f.imported,
        sliceStatus: f.sliceStatus,
        sliceSource: f.sliceSource,
        printTimeSeconds: f.printTimeSeconds,
        filamentGrams: f.filamentGrams,
        sliceError: f.sliceError,
        printerInfo: f.printerInfo,
      })),
  };
}

// Snapshots are built by buildSnapshot with a fixed key order, so JSON
// equality is a faithful deep-equality check.
export function snapshotsEqual(
  a: ModelVersionSnapshot,
  b: ModelVersionSnapshot,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// What changed between two consecutive versions, as a short " · "-joined
// phrase ("renamed to “Talon”, 2 files added, BOM updated"). Files are
// identified by s3Key — same key means same bytes, so a key present on both
// sides with a different filename is a rename, not remove+add.
export function summarizeVersionChange(
  prev: ModelVersionSnapshot | null,
  next: ModelVersionSnapshot,
): string {
  if (!prev) {
    return `${plural(next.files.length, "file")}${
      next.bom.length > 0 ? `, ${plural(next.bom.length, "BOM item")}` : ""
    }`;
  }

  const parts: string[] = [];
  if (prev.title !== next.title) parts.push(`renamed to “${next.title}”`);
  if (prev.description !== next.description) parts.push("description edited");
  if (prev.categoryId !== next.categoryId) parts.push("category changed");

  const prevFiles = new Map(prev.files.map((f) => [f.s3Key, f]));
  const nextFiles = new Map(next.files.map((f) => [f.s3Key, f]));
  const added = next.files.filter((f) => !prevFiles.has(f.s3Key));
  const removed = prev.files.filter((f) => !nextFiles.has(f.s3Key));
  const renamed = next.files.filter((f) => {
    const before = prevFiles.get(f.s3Key);
    return before !== undefined && before.filename !== f.filename;
  });
  if (added.length > 0) parts.push(`${plural(added.length, "file")} added`);
  if (removed.length > 0) parts.push(`${plural(removed.length, "file")} removed`);
  if (renamed.length > 0) parts.push(`${plural(renamed.length, "file")} renamed`);

  if (JSON.stringify(prev.tags) !== JSON.stringify(next.tags)) {
    parts.push("tags updated");
  }
  if (JSON.stringify(prev.bom) !== JSON.stringify(next.bom)) {
    parts.push("BOM updated");
  }

  if (parts.length === 0) {
    // The file sets match but some per-file metadata differs — reordering, or
    // slice estimates that landed between the two saves.
    return "file details updated";
  }
  return parts.join(", ");
}
