import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { ArchiveImportError, readModelArchive } from "@/lib/import/archive";
import { contentTypeForFilename } from "@/lib/file-kind";
import { stageBuffer } from "@/lib/storage";
import { reportError } from "@/lib/telemetry";
import type { UploadedFile } from "@/app/models/actions";
import type { ImportDraft } from "../route";

export const runtime = "nodejs";
// Every file in the archive is uploaded to S3 before the draft comes back.
export const maxDuration = 300;

// Matches the export route's MAX_EXPORT_BYTES: nothing this instance produced
// can be bigger, and the whole archive is buffered in memory to unzip it.
const MAX_ARCHIVE_BYTES = 250 * 1024 * 1024;

// Reads the whole body, refusing to buffer past the cap. Content-Length is
// only a hint (a client can understate or omit it), so the running total is
// what actually enforces the limit.
async function readBody(req: NextRequest): Promise<Uint8Array | null> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_ARCHIVE_BYTES) {
    return null;
  }
  if (!req.body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ARCHIVE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

// Imports a .zip previously produced by GET /api/models/[id]/export (issue
// #94): the archive is unpacked, its files are staged to S3 and the result
// comes back as the same draft the URL importers return, which the create
// form prefills from. Nothing is written to the catalog here — the user still
// reviews and saves the form.
//
// The zip arrives as the raw request body (like /api/upload) rather than
// multipart: there is exactly one file, and streaming it saves parsing a
// wrapper around bytes we already have to buffer whole to unzip.
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await readBody(req);
  if (!body) {
    return NextResponse.json(
      { error: "That archive is too large to import (250 MB max)" },
      { status: 413 },
    );
  }
  if (body.byteLength === 0) {
    return NextResponse.json({ error: "No archive uploaded" }, { status: 400 });
  }

  try {
    const archive = readModelArchive(body, {
      fallbackTitle: req.nextUrl.searchParams.get("filename") ?? undefined,
    });

    // Staged sequentially: a file-heavy archive would otherwise open one S3
    // upload per file at once, and the bytes are all in memory already.
    const files: UploadedFile[] = [];
    for (const file of archive.files) {
      const staged = await stageBuffer(
        file.filename,
        file.data,
        contentTypeForFilename(file.filename),
      );
      files.push({
        ...staged,
        kind: file.kind,
        // Provenance is only meaningful with a source to attribute it to;
        // createModel applies the same gate again on the way in.
        ...(file.imported ? { imported: true } : {}),
        ...(file.sourceFileId ? { sourceFileId: file.sourceFileId } : {}),
        ...(file.sourceModifiedAt
          ? { sourceModifiedAt: file.sourceModifiedAt }
          : {}),
        ...(file.onshapeElementId
          ? { onshapeElementId: file.onshapeElementId }
          : {}),
      });
    }

    const draft: ImportDraft = {
      source: "archive",
      sourceUrl: archive.sourceUrl,
      title: archive.title,
      description: archive.description,
      tags: archive.tags,
      categories: archive.categories,
      files,
      bom: archive.bom,
      videos: archive.videos,
      warnings: archive.warnings,
      onshapeMicroversion: archive.onshapeMicroversion,
    };
    return NextResponse.json(draft);
  } catch (err) {
    if (err instanceof ArchiveImportError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    reportError("Archive import failed", err);
    return NextResponse.json(
      { error: "Could not read that archive — is it a Print Vault export?" },
      { status: 500 },
    );
  }
}
