// Downloads an imported project's remote assets and stages them in S3
// ("uploads/…" keys, same shape as browser uploads). Shared by the one-shot
// import route (POST /api/import) and the background collection import job.

import { stageBuffer, stageStream } from "@/lib/storage";
import { normalizeThreeMf } from "@/lib/threemf-normalize";
import { fileExtension, IMAGE_EXTENSIONS, PDF_EXTENSIONS } from "@/lib/s3";
import { extractScadFiles } from "./scad-archive";
import { IMPORT_USER_AGENT, type ImportedProject, type RemoteAsset } from "./types";

const MAX_MODEL_BYTES = 1024 * 1024 * 1024; // 1 GB
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_PDF_BYTES = 100 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".3mf": "model/3mf",
  ".step": "model/step",
  ".stp": "model/step",
  ".scad": "application/x-openscad",
  ".pdf": "application/pdf",
};

// MakerWorld's raw-model download serves a single .scad or, when a design has
// several raw files, one zip bundling *all* of them — including hundreds of MB
// of geometry next to the tiny .scad sources. `extractScadFiles` streams the
// archive and only decompresses the .scad entries, so a large geometry payload
// never gets buffered and can't push the source over a size cap (the original
// bug: a 64 MB whole-archive cap silently dropped the .scad of big parametric
// models). Each individual .scad is still bounded — sources are text.
const MAX_SCAD_FILE_BYTES = 32 * 1024 * 1024;

async function stageScadDownload(
  asset: RemoteAsset,
  res: Response,
): Promise<StagedImportFile[]> {
  if (!res.body) return [];
  const scads = await extractScadFiles(res.body, {
    fallbackName: asset.filename,
    maxFileBytes: MAX_SCAD_FILE_BYTES,
  });
  const staged: StagedImportFile[] = [];
  for (const { name, bytes } of scads) {
    staged.push({
      ...(await stageBuffer(name, bytes, CONTENT_TYPES[".scad"])),
      kind: "model" as const,
      imported: true,
      // Per-entry id from the extracted name; the whole archive shares one
      // last-modified token (it downloads as a unit).
      sourceFileId: `scad:${name}`,
      ...(asset.sourceModifiedAt
        ? { sourceModifiedAt: asset.sourceModifiedAt }
        : {}),
    });
  }
  return staged;
}

const MAX_BYTES: Record<RemoteAsset["kind"], number> = {
  model: MAX_MODEL_BYTES,
  image: MAX_IMAGE_BYTES,
  pdf: MAX_PDF_BYTES,
};

export type StagedImportFile = {
  key: string;
  filename: string;
  size: number;
  contentType: string;
  kind: "model" | "image" | "pdf";
  onshapeElementId?: string;
  // Upstream identity + last-modified token for the source sync (mirrors
  // RemoteAsset; scad archive entries derive their id from the entry name).
  sourceFileId?: string;
  sourceModifiedAt?: string;
  // Always true — staging only exists for imports. Carried explicitly so the
  // create-form draft and the direct-insert paths can record per-file
  // provenance (model_files.imported) next to manually uploaded files.
  imported: true;
};

// Best-effort: assets that fail to download become warnings, not errors, so
// one broken image doesn't sink an otherwise fine import. Takes just the
// asset list so the source-sync route can stage a hand-picked subset.
export async function stageImportedAssets(
  project: Pick<ImportedProject, "assets">,
): Promise<{ files: StagedImportFile[]; warnings: string[] }> {
  const files: StagedImportFile[] = [];
  const warnings: string[] = [];

  for (const asset of project.assets) {
    try {
      const res = await fetch(asset.url, {
        headers: { "User-Agent": IMPORT_USER_AGENT, ...asset.headers },
        redirect: "follow",
      });
      if (!res.ok || !res.body) {
        warnings.push(`Download failed for ${asset.filename} (${res.status})`);
        continue;
      }
      const maxBytes = MAX_BYTES[asset.kind];
      const contentLength = Number(res.headers.get("content-length") ?? 0);
      if (contentLength > maxBytes) {
        warnings.push(`${asset.filename} is too large, skipped`);
        continue;
      }
      if (asset.extractScad) {
        const staged = await stageScadDownload(asset, res);
        if (staged.length === 0) {
          warnings.push(`No .scad files found in ${asset.filename}`);
        }
        files.push(...staged);
        continue;
      }
      const ext = fileExtension(asset.filename);
      // Extension-gate images and PDFs: createModel derives the stored content
      // type from the extension and rejects a kind/extension mismatch, so a
      // stray non-.pdf "document" or non-image "image" must be dropped here.
      if (asset.kind === "image" && !IMAGE_EXTENSIONS.includes(ext)) {
        continue;
      }
      if (asset.kind === "pdf" && !PDF_EXTENSIONS.includes(ext)) {
        continue;
      }
      const contentType =
        CONTENT_TYPES[ext] ??
        res.headers.get("content-type")?.split(";")[0] ??
        "application/octet-stream";
      // Onshape 3MF exports come in meters centered on the origin, which
      // desktop slicers and the estimate service can't handle — normalize
      // to millimeters on the plate before storing.
      const staged = asset.onshapeElementId
        ? await stageBuffer(
            asset.filename,
            normalizeThreeMf(new Uint8Array(await res.arrayBuffer())),
            contentType,
          )
        : await stageStream(asset.filename, res.body, contentType);
      files.push({
        ...staged,
        kind: asset.kind,
        imported: true,
        ...(asset.onshapeElementId
          ? { onshapeElementId: asset.onshapeElementId }
          : {}),
        ...(asset.sourceFileId ? { sourceFileId: asset.sourceFileId } : {}),
        ...(asset.sourceModifiedAt
          ? { sourceModifiedAt: asset.sourceModifiedAt }
          : {}),
      });
    } catch {
      warnings.push(`Download failed for ${asset.filename}`);
    }
  }

  return { files, warnings };
}
