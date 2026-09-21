// Client for the headless slicer service (./slicer), which wraps the
// PrusaSlicer CLI behind POST /estimate. Uploaded .3mf model files are marked
// sliceStatus="pending" on insert; processPendingSlices runs after the
// response (via next/server `after`) and resolves each file to:
//
// - "ok" / "embedded"  the file was already sliced in Bambu Studio/OrcaSlicer
//                      and carries predictions in Metadata/slice_info.config
// - "ok" / "slicer"    the slicer service sliced it with a generic profile —
//                      estimates, not gospel (the UI prefixes them with "~")
// - "failed"           the file cannot be sliced; surfaced to the user so
//                      they notice a broken/unprintable upload
//
// Files stay "pending" when the service is unreachable or SLICER_URL is
// unset, so nothing is permanently marked failed because of an outage.

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { modelFiles } from "@/db/schema";
import { s3, S3_BUCKET, fileExtension } from "@/lib/s3";
import { recordSliceEstimate, reportError } from "@/lib/telemetry";
import { get3mfPrinterInfo, get3mfSliceInfo } from "@/lib/threemf-remote";

// Keep in sync with MAX_BODY_BYTES in slicer/server.mjs.
const MAX_SLICE_BYTES = 256 * 1024 * 1024;
// Generous: covers the service's own 5 min slice timeout plus queueing.
const REQUEST_TIMEOUT_MS = 15 * 60_000;

export function sliceEligible(kind: string, filename: string) {
  return kind === "model" && fileExtension(filename) === ".3mf";
}

type EstimateResponse = {
  ok: boolean;
  printTimeSeconds?: number | null;
  filamentGrams?: number | null;
  error?: string;
};

type FileRow = typeof modelFiles.$inferSelect;

async function markOk(
  file: FileRow,
  source: "embedded" | "slicer",
  printTimeSeconds: number | null,
  filamentGrams: number | null,
) {
  await db
    .update(modelFiles)
    .set({
      sliceStatus: "ok",
      sliceSource: source,
      printTimeSeconds,
      filamentGrams,
      sliceError: null,
    })
    .where(eq(modelFiles.id, file.id));
}

async function markFailed(file: FileRow, error: string) {
  await db
    .update(modelFiles)
    .set({ sliceStatus: "failed", sliceError: error.slice(0, 500) })
    .where(eq(modelFiles.id, file.id));
}

async function estimateFile(file: FileRow, slicerUrl: string | undefined) {
  // The hardware the project was set up for (printer, nozzle, plate,
  // filament) is worth keeping even when estimation later fails or the
  // slicer service is down.
  const printerInfo = await get3mfPrinterInfo(file.s3Key, file.size);
  if (printerInfo) {
    // `presets` is the one field no file carries — the preset *names* only
    // exist in the live slicer, so they arrive with a slice-push and nowhere
    // else. A parse that cannot produce them must not erase them, or a synced
    // project (and any later re-slice of one) would silently lose them.
    const presets = printerInfo.presets ?? file.printerInfo?.presets;
    await db
      .update(modelFiles)
      .set({ printerInfo: presets ? { ...printerInfo, presets } : printerInfo })
      .where(eq(modelFiles.id, file.id));
  }

  // Already-sliced files carry their real predictions — no need to re-slice
  // with a generic profile.
  const embedded = await get3mfSliceInfo(file.s3Key, file.size);
  if (embedded?.printTimeSeconds != null) {
    await markOk(file, "embedded", embedded.printTimeSeconds, embedded.filamentGrams);
    recordSliceEstimate("embedded");
    return;
  }

  if (!slicerUrl) return; // no service configured — leave pending
  if (file.size > MAX_SLICE_BYTES) {
    await markFailed(file, "file too large to slice");
    recordSliceEstimate("failed");
    return;
  }

  const object = await s3.send(
    new GetObjectCommand({ Bucket: S3_BUCKET, Key: file.s3Key }),
  );
  if (!object.Body) return;

  const startedAt = performance.now();
  const elapsedSeconds = () => (performance.now() - startedAt) / 1000;
  let res: Response;
  try {
    res = await fetch(new URL("/estimate", slicerUrl), {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: object.Body.transformToWebStream(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // Node requires half-duplex for streamed request bodies.
      duplex: "half",
    } as RequestInit & { duplex: "half" });
  } catch (err) {
    reportError(`slicer unreachable for ${file.filename}`, err);
    recordSliceEstimate("unreachable", elapsedSeconds());
    return; // leave pending; a later upload cycle may retry
  }

  const result = (await res.json().catch(() => null)) as EstimateResponse | null;
  if (res.ok && result?.ok) {
    await markOk(
      file,
      "slicer",
      result.printTimeSeconds ?? null,
      result.filamentGrams ?? null,
    );
    recordSliceEstimate("sliced", elapsedSeconds());
  } else if (res.status >= 400 && res.status < 500) {
    await markFailed(file, result?.error ?? `slicer rejected the file (${res.status})`);
    recordSliceEstimate("failed", elapsedSeconds());
  } else {
    reportError(`slicer error ${res.status} for ${file.filename}`);
    recordSliceEstimate("error", elapsedSeconds());
  }
}

// Models whose pending files are currently being processed. Viewing a model
// page re-triggers processing (so files stuck pending from an outage heal
// themselves), and this keeps concurrent views from queueing the same work.
const inFlight = new Set<string>();

// The estimate a slice-push sent alongside a pushed project
// (src/lib/slice-push.ts: PushStats).
//
// A project synced out of OrcaSlicer's checkpoint carries whatever
// `slice_info.config` held when that checkpoint was last written — which
// happens on *model* changes, not when a slice finishes, so it can be the
// previous slice's predictions or nothing at all. The plugin reads the G-code
// it was handed and sends the numbers; this is where they land.
//
// Applied when the file carried no predictions of its own, and *also* over an
// estimate the slicer service produced: that one is our generic 0.4/PLA
// profile, while these came from the user's own slicer for their own printer,
// which is the same standing as a prediction read out of the file (and is why
// the UI shows it without the "~"). Never over the file's own numbers, which
// describe the file, and never over "failed" — a file the slicer service
// could not load is worth flagging rather than papering over.
export async function applyPushedEstimate(
  fileId: string,
  stats: { printTimeSeconds: number | null; filamentGrams: number | null },
) {
  if (stats.printTimeSeconds == null) return;
  await db
    .update(modelFiles)
    .set({
      sliceStatus: "ok",
      // The user's own slicer, for their own hardware — the same standing as a
      // prediction read out of the file, so the UI shows it without the "~".
      sliceSource: "embedded",
      printTimeSeconds: stats.printTimeSeconds,
      filamentGrams: stats.filamentGrams,
      sliceError: null,
    })
    .where(
      and(
        eq(modelFiles.id, fileId),
        or(
          isNull(modelFiles.sliceStatus),
          eq(modelFiles.sliceStatus, "pending"),
          eq(modelFiles.sliceSource, "slicer"),
        ),
      ),
    );
}

// Processes every pending model file of a model, sequentially — the service
// slices one file at a time anyway.
export async function processPendingSlices(modelId: string) {
  if (inFlight.has(modelId)) return;
  inFlight.add(modelId);
  try {
    const slicerUrl = process.env.SLICER_URL;
    const pending = await db.query.modelFiles.findMany({
      where: and(
        eq(modelFiles.modelId, modelId),
        eq(modelFiles.sliceStatus, "pending"),
      ),
    });
    for (const file of pending) {
      try {
        await estimateFile(file, slicerUrl);
      } catch (err) {
        reportError(`slice estimation failed for ${file.filename}`, err);
      }
    }
  } finally {
    inFlight.delete(modelId);
  }
}
