// Slice-push ingest (issue #122): the return leg of the slicer round-trip.
// The OrcaSlicer plugin (orca-plugin/) POSTs the file it just sliced here, and
// it lands on the model as a new versioned revision with its print estimates
// read back — no manual re-upload.
//
// This is a *write* surface that authenticates without a session cookie: the
// slicer has no login. It carries a push token instead (src/lib/push-token.ts,
// src/lib/push-tokens.ts), which stands for one slicer install and grants
// edit-equivalent access — the same access any signed-in user already has
// under the collaborative-editing rule, narrowed to "add a file revision" and
// revocable on its own. The model id in the path is resolved by the plugin
// through /api/slice-push/resolve before it gets here, so a mistargeted push
// is a resolve bug, not a missing check. See docs/architecture/slicing.md.

import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { modelFiles, models } from "@/db/schema";
import { contentTypeForFilename } from "@/lib/s3";
import { stageStream } from "@/lib/storage";
import {
  deleteS3Keys,
  ensureBaselineVersion,
  recordVersion,
} from "@/lib/model-versions";
import { authenticatePush, stampPushTokenUse } from "@/lib/push-tokens";
import {
  findReplaceTarget,
  normalizePushFilename,
  parsePushMeta,
  pushArtifact,
} from "@/lib/slice-push";
import { GCODE_TAIL_BYTES, TailBuffer, parseGcodeStats } from "@/lib/gcode-stats";
import { processPendingSlices } from "@/lib/slicer";
import { logger } from "@/lib/logger";
import { reportError } from "@/lib/telemetry";

export const runtime = "nodejs";
// Large G-code over a home upload link.
export const maxDuration = 300;

// Same ceiling as the slicer service accepts. A sliced G-code for a big
// multi-plate project runs to a few hundred MB; past this something is wrong.
const MAX_PUSH_BYTES = 256 * 1024 * 1024;

// Streams the body to S3, and — for G-code — keeps a rolling window of the
// tail on the way past so the footer stats can be read without ever holding
// the whole file (or reading it back out of S3 afterwards). Reports the
// over-cap case through a flag rather than the thrown error's identity, which
// does not survive the S3 upload's own error wrapping.
function tapBody(
  body: ReadableStream<Uint8Array>,
  tail: TailBuffer | null,
  state: { tooLarge: boolean },
): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        // Enforced here rather than on Content-Length alone: the header is
        // absent on a chunked upload and is client-controlled either way.
        // Erroring the stream aborts the multipart upload, so no orphaned
        // parts are left behind.
        if (seen > MAX_PUSH_BYTES) {
          state.tooLarge = true;
          throw new Error("push exceeds the size cap");
        }
        tail?.push(chunk);
        controller.enqueue(chunk);
      },
    }),
  );
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const auth = await authenticatePush(req.headers.get("authorization"));
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const model = await db.query.models.findFirst({
    where: eq(models.id, id),
    with: { files: true },
  });
  // A trashed model is not a push target — restoring it should not surprise
  // the owner with revisions pushed while it sat in the bin.
  if (!model || model.deletedAt) {
    return NextResponse.json({ error: "Model not found" }, { status: 404 });
  }

  const filename = normalizePushFilename(req.nextUrl.searchParams.get("filename"));
  if (!filename) {
    return NextResponse.json(
      { error: "filename is required and must end in .3mf or .gcode" },
      { status: 400 },
    );
  }
  const artifact = pushArtifact(filename);
  if (!req.body || !artifact) {
    return NextResponse.json({ error: "Empty request body" }, { status: 400 });
  }

  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PUSH_BYTES) {
    return NextResponse.json({ error: "File too large" }, { status: 413 });
  }

  const tail = artifact === "gcode" ? new TailBuffer(GCODE_TAIL_BYTES) : null;
  const uploadState = { tooLarge: false };
  let staged;
  try {
    staged = await stageStream(
      filename,
      tapBody(req.body, tail, uploadState),
      // Derived from the validated extension, never the request header —
      // /api/files serves stored types back, so a client-chosen text/html
      // would be stored XSS. G-code has no safe registered type and falls
      // through to application/octet-stream, which is what we want.
      contentTypeForFilename(filename),
    );
  } catch (err) {
    if (uploadState.tooLarge) {
      return NextResponse.json({ error: "File too large" }, { status: 413 });
    }
    reportError(`slice-push upload failed for model ${id}`, err);
    return NextResponse.json({ error: "Upload failed" }, { status: 502 });
  }

  // A .3mf goes down the existing route: mark it pending and let the slicer
  // pipeline read its embedded slice_info/project_settings (and fall back to
  // the slicer service when it carries no predictions). G-code carries its
  // numbers in the footer we just streamed past, so it is resolved here and
  // never queued — that path must keep working on instances with no
  // SLICER_URL at all.
  const stats = tail ? parseGcodeStats(tail.text()) : null;
  // A G-code push resolves to "ok" only when the footer actually yielded a
  // print time; a slicer that wrote none leaves the row with no estimate at
  // all, which is not the same thing as a file that failed to slice.
  const gcodeEstimated = stats?.printTimeSeconds != null;
  const sliceFields: Pick<
    typeof modelFiles.$inferInsert,
    | "sliceStatus"
    | "sliceSource"
    | "printTimeSeconds"
    | "filamentGrams"
    | "sliceError"
  > =
    artifact === "3mf"
      ? {
          sliceStatus: "pending",
          sliceSource: null,
          printTimeSeconds: null,
          filamentGrams: null,
          sliceError: null,
        }
      : {
          sliceStatus: gcodeEstimated ? "ok" : null,
          // "embedded" (not "slicer") because these are real predictions from
          // the user's own slicer for their own hardware, so the UI shows them
          // without the "~" it puts on our generic-profile estimates.
          sliceSource: gcodeEstimated ? "embedded" : null,
          printTimeSeconds: stats?.printTimeSeconds ?? null,
          filamentGrams: stats?.filamentGrams ?? null,
          sliceError: null,
        };

  // What the slicer knew and the G-code footer doesn't say: printer, nozzle,
  // plate, filament slots, and the presets that produced the file. Only the
  // plugin can supply this (a .3mf carries its own, read by the 3MF parser),
  // so it is applied to the G-code path only and left null otherwise.
  const meta = artifact === "gcode" ? parsePushMeta(req.headers.get("x-slice-push-meta")) : null;

  const replaced = findReplaceTarget(model.files, filename);

  const orphanedKeys = await db.transaction(async (tx) => {
    // Models predating versioning get their pre-push state recorded first, so
    // this revision stays revertable (issue #55).
    await ensureBaselineVersion(tx, model.id, model.userId);

    if (replaced) {
      await tx
        .update(modelFiles)
        .set({
          s3Key: staged.key,
          size: staged.size,
          contentType: staged.contentType,
          contentHash: staged.contentHash,
          // The bytes are now this instance's own, not the source platform's.
          // Leaving `imported` set would let the next MakerWorld/Printables
          // sync overwrite the tuned file with the upstream one — losing
          // exactly what this feature exists to keep.
          imported: false,
          printerInfo: meta,
          ...sliceFields,
        })
        .where(eq(modelFiles.id, replaced.id));
    } else {
      const position = Math.max(0, ...model.files.map((f) => f.position + 1));
      await tx.insert(modelFiles).values({
        modelId: model.id,
        kind: "model" as const,
        filename,
        s3Key: staged.key,
        size: staged.size,
        contentType: staged.contentType,
        contentHash: staged.contentHash,
        position,
        printerInfo: meta,
        ...sliceFields,
      });
    }

    await tx
      .update(models)
      .set({ updatedAt: new Date() })
      .where(eq(models.id, model.id));

    // Last, inside the same transaction — the replaced file's old bytes stay
    // in S3 because the snapshot taken before this one still references them;
    // only keys no remaining snapshot or live row references come back here.
    return recordVersion(tx, model.id, auth.userId, "slice-push");
  });

  if (orphanedKeys.length > 0) {
    try {
      await deleteS3Keys(orphanedKeys);
    } catch (err) {
      // A pruned snapshot's objects leaking is not worth failing the push the
      // user's slicer just made.
      reportError(`slice-push S3 cleanup failed for model ${id}`, err);
    }
  }

  // Bookkeeping only, and deliberately non-fatal: the revision is already
  // committed, so turning a failure here into a 5xx would make the plugin
  // retry a push that actually succeeded and record a second revision.
  try {
    await stampPushTokenUse(auth.tokenId);
  } catch (err) {
    reportError(`slice-push could not stamp token ${auth.tokenId}`, err);
  }

  logger.info(
    {
      modelId: model.id,
      filename,
      artifact,
      bytes: staged.size,
      replaced: !!replaced,
    },
    "slice-push accepted",
  );

  if (artifact === "3mf") after(() => processPendingSlices(model.id));
  revalidatePath(`/models/${model.id}`);

  return NextResponse.json({
    status: replaced ? "replaced" : "added",
    filename,
    printTimeSeconds: sliceFields.printTimeSeconds ?? null,
    filamentGrams: sliceFields.filamentGrams ?? null,
  });
}
