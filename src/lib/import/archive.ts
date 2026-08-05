// Reads a Print Vault export zip back into a create-form draft (issue #94,
// the import half). Pure — fflate plus the BOM/filename helpers, no S3 and no
// db — so it stays unit-testable; src/app/api/import/archive/route.ts buffers
// the upload, stages the extracted bytes and hands the rest to the same
// sessionStorage draft the URL importers write.
//
// Two archive shapes have to be read:
//
//   - **With `metadata.json`** (src/lib/model-export.ts writes it): every
//     field is taken from the manifest — tags, category, BOM sections and each
//     file's kind and provenance, none of which the folder tree can express.
//   - **Without it** — zips exported before the manifest existed. The folder a
//     file sits in gives its kind, `README.md` gives the title and
//     description, `bom.csv` gives a section-less BOM.
//
// Everything the manifest says is treated as untrusted input: it travels
// through a user-supplied file, so kinds are re-checked against the extension
// allowlist and names are re-sanitized exactly as the exporter sanitized them.

import { strFromU8, unzipSync, type UnzipFileInfo } from "fflate";
import { parseBomCsv, type BomItemInput } from "@/lib/bom";
import { MAX_MODEL_VIDEOS, type ModelVideo } from "@/lib/video";
import { allowedExtensions, fileExtension } from "@/lib/file-kind";
import {
  EXPORT_FORMAT_VERSION,
  EXPORT_METADATA_PATH,
  safeEntryName,
  type ModelExportManifest,
} from "@/lib/model-export";
import type { FileKind } from "@/db/schema";

export class ArchiveImportError extends Error {}

// Folder → kind, the inverse of the exporter's FOLDERS map. Also the fallback
// for manifest-less archives, which is why it stays a plain lookup.
const KIND_BY_FOLDER: Record<string, FileKind> = {
  files: "model",
  documents: "pdf",
  images: "image",
  videos: "video",
};

// Guards on what a single upload may expand to. The route caps the compressed
// bytes it accepts, which says nothing about what they decompress to — a
// hostile zip a few hundred KB long can claim gigabytes ("zip bomb"), and
// unzipSync would happily allocate them. Both budgets are enforced while
// filtering entries, before any decompression happens.
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 300;

export type ArchiveFile = {
  filename: string;
  kind: FileKind;
  data: Uint8Array;
  imported: boolean;
  sourceFileId: string | null;
  sourceModifiedAt: string | null;
  onshapeElementId: string | null;
};

export type ArchiveImport = {
  title: string;
  description: string;
  tags: string[];
  // The exported category name, passed to the create form as a source-category
  // hint so suggestCategory can match it against *this* instance's categories
  // (ids don't survive the trip between instances).
  categories: string[];
  sourceUrl: string;
  onshapeMicroversion: string | null;
  // Gallery videos off the manifest, with the slots they held in the
  // exporting instance's carousel; createModel re-validates every link.
  videos: ModelVideo[];
  bom: BomItemInput[];
  files: ArchiveFile[];
  warnings: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

function stringList(value: unknown, max: number): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && !!v.trim()).slice(0, max)
    : [];
}

// The folder an entry sits in decides its kind; anything at the root or
// nested deeper (a stray "images/thumbs/x.png") is not part of the layout.
function pathKind(path: string): FileKind | null {
  const segments = path.split("/");
  return segments.length === 2 && segments[1] ? (KIND_BY_FOLDER[segments[0]] ?? null) : null;
}

// Which entries are worth decompressing at all — the three text files plus
// anything sitting in a known folder with an extension that folder allows.
// Runs before decompression, so it doubles as the place the size/count budgets
// are enforced (fflate hands us `originalSize` straight from the zip header).
function entryFilter(warnings: string[]) {
  let unpacked = 0;
  let count = 0;
  let budgetHit = false;
  return (entry: UnzipFileInfo): boolean => {
    const path = entry.name;
    if (path.endsWith("/")) return false;
    const wanted =
      path === EXPORT_METADATA_PATH ||
      path === "README.md" ||
      path === "bom.csv" ||
      (() => {
        const kind = pathKind(path);
        return (
          kind !== null &&
          allowedExtensions(kind).includes(fileExtension(path))
        );
      })();
    if (!wanted) return false;
    if (count >= MAX_FILES || unpacked + entry.originalSize > MAX_UNPACKED_BYTES) {
      if (!budgetHit) {
        budgetHit = true;
        warnings.push(
          "The archive is larger than an import can hold — some files were skipped",
        );
      }
      return false;
    }
    count++;
    unpacked += entry.originalSize;
    return true;
  };
}

// Title and description out of README.md, for archives with no manifest. The
// exporter writes "# <title>", then the "*Print Vault export · version N*"
// line, then the description verbatim — so drop the first heading and that
// marker line and the rest is the description as it was authored.
export function parseExportReadme(text: string): {
  title: string;
  description: string;
} {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let title = "";
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const heading = /^#\s+(.*)$/.exec(line);
    if (heading) {
      title = heading[1].trim();
      start = i + 1;
    }
    break;
  }
  const body = lines.slice(start);
  while (body.length > 0 && !body[0].trim()) body.shift();
  if (body.length > 0 && /^\*Print Vault export .*\*$/.test(body[0].trim())) {
    body.shift();
  }
  return { title, description: body.join("\n").trim() };
}

// BOM straight off the manifest. Not run through sanitizeBomItems here — the
// create action sanitizes everything it is given anyway, and doing it twice
// would mean this module has to decide what to do with a rejection it can't
// report per-item.
function manifestBom(value: unknown): BomItemInput[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((raw) => ({
    name: asString(raw.name, 500) ?? "",
    quantity: asString(raw.quantity, 100) ?? "1",
    link: asString(raw.link, 2000),
    imageUrl: asString(raw.imageUrl, 2000),
    section: asString(raw.section, 200),
  }));
}

// Gallery videos off the manifest. Like the BOM, not re-validated here — the
// create action parses every link and drops what it can't embed; this only
// has to make sure the shape is a list of {url, position}.
function manifestVideos(value: unknown): ModelVideo[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .flatMap((raw) => {
      const url = asString(raw.url, 2000);
      return url
        ? [
            {
              url,
              position:
                typeof raw.position === "number" && Number.isSafeInteger(raw.position)
                  ? raw.position
                  : 0,
            },
          ]
        : [];
    })
    .slice(0, MAX_MODEL_VIDEOS);
}

function readManifest(
  entries: Record<string, Uint8Array>,
  warnings: string[],
): ModelExportManifest | null {
  const raw = entries[EXPORT_METADATA_PATH];
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(strFromU8(raw));
  } catch {
    warnings.push("The archive's metadata.json is unreadable — falling back to its folders");
    return null;
  }
  if (!isRecord(parsed)) return null;
  // A newer instance's archive still imports: unknown fields are ignored and
  // the known ones are read as usual. Only worth saying so.
  if (
    typeof parsed.formatVersion === "number" &&
    parsed.formatVersion > EXPORT_FORMAT_VERSION
  ) {
    warnings.push(
      "This archive was exported by a newer version of Print Vault — anything it added is ignored",
    );
  }
  return parsed as unknown as ModelExportManifest;
}

// One archive file, with the manifest's claims about it re-validated. Returns
// null when the entry can't be a file of that kind at all.
function buildFile(
  path: string,
  data: Uint8Array,
  kind: FileKind,
  meta: Partial<ModelExportManifest["files"][number]>,
): ArchiveFile | null {
  // The manifest's filename is as user-controlled as the entry name was on
  // the way out, so it gets the same treatment; the entry's own basename is
  // the fallback when the manifest doesn't name the file.
  const filename = safeEntryName(
    asString(meta.filename, 255) || (path.split("/").pop() ?? path),
  );
  // Kind and extension have to agree — createModel rejects the mismatch, and
  // the stored content type is derived from the extension, so a manifest
  // claiming a .html is an "image" must not get that far.
  if (!allowedExtensions(kind).includes(fileExtension(filename))) return null;
  return {
    filename,
    kind,
    data,
    imported: meta.imported === true,
    sourceFileId: asString(meta.sourceFileId, 200),
    sourceModifiedAt: asString(meta.sourceModifiedAt, 100),
    onshapeElementId: asString(meta.onshapeElementId, 100),
  };
}

// Manifest-less archives: every entry in a known folder, in path order.
function filesFromLayout(entries: Record<string, Uint8Array>): ArchiveFile[] {
  const files: ArchiveFile[] = [];
  for (const path of Object.keys(entries).sort()) {
    const kind = pathKind(path);
    if (!kind) continue;
    const file = buildFile(path, entries[path], kind, {});
    if (file) files.push(file);
  }
  return files;
}

// Manifest archives: the manifest's own order (which is the model's file
// order), skipping entries it names but the zip doesn't carry.
function filesFromManifest(
  entries: Record<string, Uint8Array>,
  manifest: ModelExportManifest,
  warnings: string[],
): ArchiveFile[] {
  const files: ArchiveFile[] = [];
  let generated = 0;
  for (const meta of Array.isArray(manifest.files) ? manifest.files : []) {
    if (!isRecord(meta)) continue;
    // A variant belongs to the .scad it was rendered from, and that link
    // can't survive the trip — importing it as a standalone file would just
    // duplicate geometry the customizer can produce again on demand.
    if (meta.generated === true) {
      generated++;
      continue;
    }
    const path = asString(meta.path, 1000);
    const data = path ? entries[path] : undefined;
    if (!path || !data) continue;
    // Trust the folder over the manifest's `kind` when they disagree: the
    // folder is where the bytes actually are, and both are checked against
    // the extension anyway.
    const kind = pathKind(path);
    if (!kind) continue;
    const file = buildFile(path, data, kind, meta);
    if (file) files.push(file);
  }
  if (generated > 0) {
    warnings.push(
      `Skipped ${generated} customizer-generated ${generated === 1 ? "file" : "files"} — regenerate them from the .scad source after saving`,
    );
  }
  return files;
}

// Turns an exported .zip into the same draft shape the URL importers produce.
// `fallbackTitle` is the uploaded file's name, used only when neither the
// manifest nor the README names the model.
export function readModelArchive(
  zip: Uint8Array,
  opts: { fallbackTitle?: string } = {},
): ArchiveImport {
  const warnings: string[] = [];
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip, { filter: entryFilter(warnings) });
  } catch {
    throw new ArchiveImportError("That file isn't a readable .zip archive");
  }

  const manifest = readManifest(entries, warnings);
  const readme = entries["README.md"]
    ? parseExportReadme(strFromU8(entries["README.md"]))
    : { title: "", description: "" };

  const model = isRecord(manifest?.model) ? manifest.model : null;
  const title =
    asString(model?.title, 500)?.trim() ||
    readme.title ||
    (opts.fallbackTitle ?? "").replace(/\.zip$/i, "").trim();
  const description = asString(model?.description, 100_000) ?? readme.description;

  let bom = manifest ? manifestBom(manifest.bom) : [];
  if (bom.length === 0 && entries["bom.csv"]) {
    const parsed = parseBomCsv(strFromU8(entries["bom.csv"]));
    if ("items" in parsed) bom = parsed.items;
  }

  const files = manifest
    ? filesFromManifest(entries, manifest, warnings)
    : filesFromLayout(entries);
  if (!files.some((f) => f.kind === "model")) {
    throw new ArchiveImportError(
      "No model files found in that archive — expected a Print Vault export with a files/ folder",
    );
  }

  return {
    title,
    description,
    tags: stringList(model?.tags, 50),
    categories: [asString(model?.category, 200) ?? ""].filter(Boolean),
    // Kept so a restored model still links to (and syncs with) the platform
    // it originally came from; createModel re-validates the host and drops
    // anything else.
    sourceUrl: asString(model?.sourceUrl, 2000) ?? "",
    onshapeMicroversion: asString(model?.onshapeMicroversion, 100),
    videos: manifestVideos(model?.videos),
    bom,
    files,
    warnings,
  };
}
