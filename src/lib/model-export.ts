// Builds the .zip a model exports to (issue #94): README.md + bom.csv + the
// model's files grouped into folders. Pure (fflate + the BOM serializer only,
// no S3/db) so it stays unit-testable — src/app/api/models/[id]/export/route.ts
// does the S3 reads and wires them to this.
//
// The layout is deliberately a plain folder tree a human can read, not an
// import manifest: re-importing an export is a separate follow-up that would
// need its own metadata format (folder names alone can't tell a .scad source
// from a generated variant).

import { strToU8, zipSync, type Zippable } from "fflate";
import { bomToCsv, type BomItemInput } from "@/lib/bom";
import { safeFileBase } from "@/lib/file-kind";
import type { FileKind } from "@/db/schema";

export type ExportFile = {
  kind: FileKind;
  filename: string;
  data: Uint8Array;
};

export type ModelExportInput = {
  title: string;
  description: string;
  // Number of the version being exported — always the current one, and always
  // the number the History panel shows for it (see exportedVersionNumber).
  version: number;
  bomItems: BomItemInput[];
  files: ExportFile[];
};

const FOLDERS: Record<FileKind, string> = {
  model: "files",
  pdf: "documents",
  image: "images",
};

// Payloads that carry their own compression (.3mf is itself a zip; images and
// PDFs are compressed formats) are stored rather than deflated — deflating
// them again costs CPU on every export for roughly nothing.
const STORED_EXTENSIONS = new Set([
  ".3mf",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".pdf",
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
// traversal names outright.
function safeEntryName(filename: string): string {
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
  // to include, include nothing" rule as the CSV download route's 404).
  if (model.bomItems.length > 0) {
    entries["bom.csv"] = strToU8(bomToCsv(model.bomItems));
  }

  const usedNames = new Map<string, Set<string>>();
  for (const file of model.files) {
    const folder = FOLDERS[file.kind];
    let used = usedNames.get(folder);
    if (!used) usedNames.set(folder, (used = new Set()));
    const name = dedupe(used, safeEntryName(file.filename));
    const [, ext] = splitExtension(name);
    entries[`${folder}/${name}`] = [
      file.data,
      { level: STORED_EXTENSIONS.has(ext.toLowerCase()) ? 0 : 6 },
    ];
  }

  return zipSync(entries);
}
