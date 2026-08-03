import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { modelVersions, models } from "@/db/schema";
import { getSession } from "@/lib/auth";
import {
  buildModelExportZip,
  exportZipName,
  exportedVersionNumber,
  type ExportFile,
} from "@/lib/model-export";
import { readFileBytes } from "@/lib/storage";

export const runtime = "nodejs";
// Every attached file is read from S3 before the zip is built, so this is
// slower than the other model routes on a file-heavy model.
export const maxDuration = 120;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// zipSync buffers the whole archive (plus its inputs) in memory, so the export
// refuses models whose files together would blow up the server. Well past any
// realistic model; revisit with a streaming zip if that stops being true.
const MAX_EXPORT_BYTES = 250 * 1024 * 1024;

// Downloads the model's current state as a .zip: README.md (title, version,
// description), bom.csv, and the live files under files/ documents/ images/.
// Only the live files — model_versions snapshots are not exported (see
// docs/architecture/versioning.md). Non-destructive, so it is session-gated
// but not owner-gated, exactly like the per-file downloads it bundles.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Fetched by the model page's Export button (export-button.tsx), so the
  // session cookie is always present — no need for the file-token mechanism.
  if (!(await getSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const model = await db.query.models.findFirst({
    where: and(eq(models.id, id), isNull(models.deletedAt)),
    columns: {
      title: true,
      description: true,
      sourceUrl: true,
      onshapeMicroversion: true,
      videos: true,
    },
    with: {
      // Ordered so the dedupe suffixes ("part-2.3mf") are stable across
      // repeated exports of an unchanged model.
      files: {
        columns: {
          kind: true,
          filename: true,
          s3Key: true,
          size: true,
          // Manifest-only, for a faithful re-import (see model-export.ts).
          imported: true,
          sourceFileId: true,
          sourceModifiedAt: true,
          onshapeElementId: true,
          generatedFromId: true,
        },
        orderBy: (f, { asc }) => [asc(f.position), asc(f.id)],
      },
      bomItems: { orderBy: (b, { asc }) => asc(b.position) },
      category: { columns: { name: true } },
      modelTags: { with: { tag: true } },
    },
  });
  if (!model) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const totalBytes = model.files.reduce((sum, f) => sum + f.size, 0);
  if (totalBytes > MAX_EXPORT_BYTES) {
    return NextResponse.json(
      { error: "This model's files are too large to export as a single zip" },
      { status: 413 },
    );
  }

  // The exported state is the current one, so the version it corresponds to is
  // the newest — named after the History panel's numbering so a downloaded
  // "…_v5.zip" matches the v5 the user sees in the app.
  const version = exportedVersionNumber(
    await db.$count(modelVersions, eq(modelVersions.modelId, id)),
  );

  const files: ExportFile[] = (
    await Promise.all(
      model.files.map(async (file): Promise<ExportFile | null> => {
        const data = await readFileBytes(file.s3Key);
        return data
          ? {
              kind: file.kind,
              filename: file.filename,
              data,
              imported: file.imported,
              sourceFileId: file.sourceFileId,
              sourceModifiedAt: file.sourceModifiedAt,
              onshapeElementId: file.onshapeElementId,
              generated: file.generatedFromId !== null,
            }
          : null;
      }),
    )
  ).filter((file) => file !== null);

  const zip = buildModelExportZip({
    title: model.title,
    description: model.description,
    version,
    tags: model.modelTags.map((mt) => mt.tag.name),
    category: model.category?.name ?? null,
    sourceUrl: model.sourceUrl,
    onshapeMicroversion: model.onshapeMicroversion,
    videos: model.videos,
    exportedAt: new Date(),
    bomItems: model.bomItems,
    files,
  });

  // BodyInit only accepts an ArrayBuffer-backed view; zipSync never allocates
  // onto a SharedArrayBuffer, so the narrowing is safe.
  return new Response(zip as Uint8Array<ArrayBuffer>, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(zip.byteLength),
      "Content-Disposition": `attachment; filename="${exportZipName(model.title, version)}"`,
      "X-Content-Type-Options": "nosniff",
      // Reflects the model's live state, so never cached.
      "Cache-Control": "private, no-store",
    },
  });
}
