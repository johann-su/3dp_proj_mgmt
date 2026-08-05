// Builds the .zip a model exports to (issue #94): metadata.json + README.md +
// bom.csv + the model's files grouped into folders. Pure (fflate + the BOM
// serializer only, no S3/db) so it stays unit-testable —
// src/app/api/models/[id]/export/route.ts does the S3 reads and wires them to
// this.
//
// The folder tree is for humans; `metadata.json` is what makes the archive
// re-importable (src/lib/import/archive.ts). It exists because the tree alone
// is lossy — folder names carry no tags, no category, no BOM sections, and
// can't tell a hand-uploaded .3mf from one the customizer generated from a
// .scad. Anything added to the manifest has to stay optional on the reading
// side: archives written by older versions have no manifest at all.

import { strToU8, zipSync, type Zippable } from "fflate";
import { bomToCsv, type BomItemInput } from "@/lib/bom";
import { safeFileBase } from "@/lib/file-kind";
import type { FileKind } from "@/db/schema";
import type { ModelVideo } from "@/lib/video";

export type ExportFile = {
  kind: FileKind;
  filename: string;
  data: Uint8Array;
  // Per-file provenance (model_files columns), recorded so a re-import
  // restores a model that still syncs against its original source rather than
  // one that looks hand-uploaded. Meaningless without the model's sourceUrl,
  // which the importer re-applies the same gate to.
  imported?: boolean;
  sourceFileId?: string | null;
  sourceModifiedAt?: string | null;
  onshapeElementId?: string | null;
  // A .3mf the customizer rendered from a .scad in this same model. Kept in
  // the zip (an offline copy should hold every file the model page offers)
  // but flagged, because re-importing it as a standalone file would produce a
  // duplicate detached from the source it belongs to.
  generated?: boolean;
};

export type ModelExportInput = {
  title: string;
  description: string;
  // Number of the version being exported — always the current one, and always
  // the number the History panel shows for it (see exportedVersionNumber).
  version: number;
  tags: string[];
  // Category *name*, not id: ids are per-instance, and the importer resolves
  // the name against the categories of the instance being imported into.
  category: string | null;
  sourceUrl: string | null;
  onshapeMicroversion: string | null;
  // Gallery videos with their slots in the combined order. Nothing to put in
  // the zip tree — they are links, not files — so the manifest is the only
  // place they survive the round trip.
  videos: ModelVideo[];
  exportedAt: Date;
  bomItems: BomItemInput[];
  files: ExportFile[];
};

// Bumped only for a change the current reader could not make sense of.
// Additive fields don't bump it — src/lib/import/archive.ts treats every
// manifest field as optional, so an older reader ignores what it doesn't know.
export const EXPORT_FORMAT_VERSION = 1;
export const EXPORT_METADATA_PATH = "metadata.json";

// The manifest, as written to metadata.json. `path` is the (sanitized,
// deduped) zip entry name; `filename` is what the file is actually called on
// the model, which the two can differ on after a collision.
export type ModelExportManifest = {
  formatVersion: number;
  application: "print-vault";
  exportedAt: string;
  version: number;
  model: {
    title: string;
    description: string;
    category: string | null;
    tags: string[];
    sourceUrl: string | null;
    onshapeMicroversion: string | null;
    videos: ModelVideo[];
  };
  bom: BomItemInput[];
  files: {
    path: string;
    kind: FileKind;
    filename: string;
    imported: boolean;
    generated: boolean;
    sourceFileId: string | null;
    sourceModifiedAt: string | null;
    onshapeElementId: string | null;
  }[];
};

const FOLDERS: Record<FileKind, string> = {
  model: "files",
  pdf: "documents",
  image: "images",
  video: "videos",
};

// Payloads that carry their own compression (.3mf is itself a zip; images,
// video and PDFs are compressed formats) are stored rather than deflated —
// deflating them again costs CPU on every export for roughly nothing.
const STORED_EXTENSIONS = new Set([
  ".3mf",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".pdf",
  ".mp4",
  ".webm",
  ".mov",
]);

// Splits a filename into base + extension, preserving the original case (unlike
// fileExtension, which lowercases — the export keeps names as the user sees
// them). A leading dot is part of the base: ".gitignore" has no extension.
function splitExtension(filename: string): [string, string] {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? [filename.slice(0, dot), filename.slice(dot)] : [filename, ""];
}

// Entry names come from user-controlled filenames (upload and rename), and a
// "../" or "/" in one would let an extractor write outside the destination
// folder ("zip slip"). Keep the last path segment only and refuse the
// traversal names outright. Exported because the archive importer has to
// re-apply it to the manifest's `filename` values, which are just as
// user-controlled on the way back in.
export function safeEntryName(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? "";
  // Control characters (a newline or NUL smuggled into a filename) are dropped
  // too — as a code-point filter rather than a regex range, which would trip
  // no-control-regex.
  const cleaned = [...base]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .trim();
  return !cleaned || cleaned === "." || cleaned === ".." ? "file" : cleaned;
}

// model_files.filename isn't unique, so one folder can end up with two files
// of the same name; the second becomes "part-2.3mf". Collisions are detected
// case-insensitively because the zip is extracted onto macOS/Windows
// filesystems that treat "Part.3mf" and "part.3mf" as the same file.
function dedupe(used: Set<string>, filename: string): string {
  const [base, ext] = splitExtension(filename);
  let candidate = filename;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) {
    candidate = `${base}-${n}${ext}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

// Which version number the export carries. Models predating versioning have
// no version rows at all, and the version cap prunes the oldest ones, so the
// current version's number is just how many rows remain — exactly how the
// History panel numbers them (src/app/models/[id]/page.tsx), which is what the
// filename has to agree with. A model with no rows displays as v1.
export function exportedVersionNumber(versionCount: number): number {
  return Math.max(versionCount, 1);
}

// "Bracket_v5.zip" — the version pins which snapshot of the model a stray zip
// on someone's disk actually is.
export function exportZipName(title: string, version: number): string {
  return `${safeFileBase(title)}_v${version}.zip`;
}

// The description is already Markdown source (it is rendered with
// react-markdown, never as raw HTML), so it goes in verbatim under the title
// and the version line — which says which snapshot of the model this copy is,
// the same thing the zip's filename carries.
export function exportReadme(
  title: string,
  description: string,
  version: number,
): string {
  const parts = [
    `# ${title.trim() || "Untitled model"}`,
    `*Print Vault export · version ${version}*`,
  ];
  const body = description.trim();
  if (body) parts.push(body);
  return parts.join("\n\n") + "\n";
}

export function buildModelExportZip(model: ModelExportInput): Uint8Array {
  const entries: Zippable = {
    "README.md": strToU8(
      exportReadme(model.title, model.description, model.version),
    ),
  };
  // No BOM → no bom.csv at all, rather than a header-only file (same "nothing
  // to include, include nothing" rule as the CSV download route's 404). The
  // manifest always carries the BOM, sections included — bom.csv is the flat
  // human/spreadsheet copy.
  if (model.bomItems.length > 0) {
    entries["bom.csv"] = strToU8(bomToCsv(model.bomItems));
  }

  const manifestFiles: ModelExportManifest["files"] = [];
  const usedNames = new Map<string, Set<string>>();
  for (const file of model.files) {
    const folder = FOLDERS[file.kind];
    let used = usedNames.get(folder);
    if (!used) usedNames.set(folder, (used = new Set()));
    const name = dedupe(used, safeEntryName(file.filename));
    const [, ext] = splitExtension(name);
    const path = `${folder}/${name}`;
    entries[path] = [
      file.data,
      { level: STORED_EXTENSIONS.has(ext.toLowerCase()) ? 0 : 6 },
    ];
    manifestFiles.push({
      path,
      kind: file.kind,
      filename: file.filename,
      imported: file.imported === true,
      generated: file.generated === true,
      sourceFileId: file.sourceFileId ?? null,
      sourceModifiedAt: file.sourceModifiedAt ?? null,
      onshapeElementId: file.onshapeElementId ?? null,
    });
  }

  const manifest: ModelExportManifest = {
    formatVersion: EXPORT_FORMAT_VERSION,
    application: "print-vault",
    exportedAt: model.exportedAt.toISOString(),
    version: model.version,
    model: {
      title: model.title,
      description: model.description,
      category: model.category,
      // Sorted so two exports of an unchanged model produce the same
      // manifest — the tag rows come back in join order, which isn't stable.
      tags: [...model.tags].sort(),
      sourceUrl: model.sourceUrl,
      onshapeMicroversion: model.onshapeMicroversion,
      videos: model.videos,
    },
    // Projected field by field on purpose: callers pass whole bom_items rows,
    // and spreading those would publish this instance's row ids and model id
    // in a file the user hands to other people.
    bom: model.bomItems.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      link: item.link,
      imageUrl: item.imageUrl,
      section: item.section,
    })),
    files: manifestFiles,
  };
  entries[EXPORT_METADATA_PATH] = strToU8(JSON.stringify(manifest, null, 2));

  return zipSync(entries);
}
