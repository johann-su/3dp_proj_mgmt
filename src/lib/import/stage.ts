// Downloads an imported project's remote assets and stages them in S3
// ("uploads/…" keys, same shape as browser uploads). Shared by the one-shot
// import route (POST /api/import) and the background collection import job.

import { stageBuffer, stageStream } from "@/lib/storage";
import { normalizeThreeMf } from "@/lib/threemf-normalize";
import { fileExtension, IMAGE_EXTENSIONS, PDF_EXTENSIONS } from "@/lib/s3";
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
  ".pdf": "application/pdf",
};

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
};

// Best-effort: assets that fail to download become warnings, not errors, so
// one broken image doesn't sink an otherwise fine import.
export async function stageImportedAssets(
  project: ImportedProject,
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
        ...(asset.onshapeElementId
          ? { onshapeElementId: asset.onshapeElementId }
          : {}),
      });
    } catch {
      warnings.push(`Download failed for ${asset.filename}`);
    }
  }

  return { files, warnings };
}
