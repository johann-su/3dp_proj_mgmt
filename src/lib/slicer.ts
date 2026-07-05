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
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { modelFiles } from "@/db/schema";
import { s3, S3_BUCKET, fileExtension } from "@/lib/s3";
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
    await db
      .update(modelFiles)
      .set({ printerInfo })
      .where(eq(modelFiles.id, file.id));
  }

  // Already-sliced files carry their real predictions — no need to re-slice
  // with a generic profile.
  const embedded = await get3mfSliceInfo(file.s3Key, file.size);
  if (embedded?.printTimeSeconds != null) {
    await markOk(file, "embedded", embedded.printTimeSeconds, embedded.filamentGrams);
    return;
  }

  if (!slicerUrl) return; // no service configured — leave pending
  if (file.size > MAX_SLICE_BYTES) {
    await markFailed(file, "file too large to slice");
    return;
  }

  const object = await s3.send(
    new GetObjectCommand({ Bucket: S3_BUCKET, Key: file.s3Key }),
  );
  if (!object.Body) return;

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
    console.error(`slicer unreachable for ${file.filename}:`, err);
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
  } else if (res.status >= 400 && res.status < 500) {
    await markFailed(file, result?.error ?? `slicer rejected the file (${res.status})`);
  } else {
    console.error(`slicer error ${res.status} for ${file.filename}`);
  }
}

// Processes every pending model file of a model, sequentially — the service
// slices one file at a time anyway.
export async function processPendingSlices(modelId: string) {
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
      console.error(`slice estimation failed for ${file.filename}:`, err);
    }
  }
}
