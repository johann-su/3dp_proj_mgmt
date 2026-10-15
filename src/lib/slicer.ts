// Client for the headless slicer service (./slicer), which wraps the
// OrcaSlicer CLI behind POST /estimate. Uploaded .3mf model files are marked
// sliceStatus="pending" on insert; processPendingSlices runs after the
// response (via next/server `after`) and resolves each file to:
//
// - "ok" / "embedded"  the file was already sliced in Bambu Studio/OrcaSlicer
//                      and carries predictions in Metadata/slice_info.config
// - "ok" / "slicer"    the slicer service sliced it — with the project's own
//                      settings where it has them, else its generic printer
//                      (stored as slicePrinter); estimates, not gospel (the
//                      UI prefixes them with "~")
// - "failed"           the file cannot be sliced; surfaced to the user so
//                      they notice a broken/unprintable upload
//
// Files stay "pending" when the service is unreachable or SLICER_URL is
// unset, so nothing is permanently marked failed because of an outage.

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { modelFiles, type PrinterInfo } from "@/db/schema";
import { fileExtension } from "@/lib/file-kind";
import { filamentChangesFromPlates } from "@/lib/printer-info";
import { blobStore } from "@/lib/storage";
import { recordSliceEstimate, reportError } from "@/lib/telemetry";
import { creatorFallback } from "@/lib/file-creator";
import { get3mfCreator, get3mfPrinterInfo, get3mfSliceInfo } from "@/lib/threemf-remote";

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
  // "file" = sliced with the file's own settings, "generic" = the service's
  // generic printer, named in `printer`.
  profile?: "file" | "generic";
  engine?: string | null;
  printer?: string | null;
  // Filament types per sliced plate.
  plateFilaments?: string[][];
  // Project settings the service had to change so a newer slicer's file would
  // slice (logged by the service; the estimate may be less exact).
  repairedSettings?: string[];
  // False when the file was sliced exactly as its own slicer would; absent
  // from older services (then treated as approximate).
  approx?: boolean;
  error?: string;
};

type FileRow = typeof modelFiles.$inferSelect;

async function markOk(
  file: FileRow,
  source: "embedded" | "slicer",
  result: {
    printTimeSeconds: number | null;
    filamentGrams: number | null;
    engine: string | null;
    approx: boolean;
    slicePrinter?: string | null;
    printerInfo?: PrinterInfo | null;
  },
) {
  await db
    .update(modelFiles)
    .set({
      sliceStatus: "ok",
      sliceSource: source,
      printTimeSeconds: result.printTimeSeconds,
      filamentGrams: result.filamentGrams,
      sliceEngine: result.engine,
      sliceApprox: result.approx,
      slicePrinter: result.slicePrinter ?? null,
      sliceError: null,
      ...(result.printerInfo !== undefined && { printerInfo: result.printerInfo }),
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
  // Which app made the file (for routing to a slicer backend later): its own
  // metadata, else where it came from (Onshape export, OpenSCAD variant).
  const creator =
    (await get3mfCreator(file.s3Key, file.size)) ?? creatorFallback(file);
  if (printerInfo || creator) {
    await db
      .update(modelFiles)
      .set({
        ...(printerInfo && { printerInfo }),
        ...(creator && { creatorApp: creator.app, creatorVersion: creator.version }),
      })
      .where(eq(modelFiles.id, file.id));
  }

  // Already-sliced files carry their real predictions — no need to re-slice
  // with a generic profile.
  const embedded = await get3mfSliceInfo(file.s3Key, file.size);
  if (embedded?.printTimeSeconds != null) {
    await markOk(file, "embedded", {
      printTimeSeconds: embedded.printTimeSeconds,
      filamentGrams: embedded.filamentGrams,
      engine: embedded.engine,
      approx: false, // the file's own slicer's numbers
    });
    recordSliceEstimate("embedded");
    return;
  }

  if (!slicerUrl) return; // no service configured — leave pending
  if (file.size > MAX_SLICE_BYTES) {
    await markFailed(file, "file too large to slice");
    recordSliceEstimate("failed");
    return;
  }

  const object = await blobStore().get(file.s3Key);
  if (!object) return;

  const startedAt = performance.now();
  const elapsedSeconds = () => (performance.now() - startedAt) / 1000;
  let res: Response;
  try {
    res = await fetch(new URL("/estimate", slicerUrl), {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: object.stream,
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
    // Only the sliced result knows whether a plate changes filament mid-print
    // (painted multi-colour, per-part filaments); it joins the hardware facts
    // read from the file's own config.
    const filamentChanges = filamentChangesFromPlates(result.plateFilaments);
    await markOk(file, "slicer", {
      printTimeSeconds: result.printTimeSeconds ?? null,
      filamentGrams: result.filamentGrams ?? null,
      engine: result.engine ?? null,
      approx: result.approx ?? true,
      slicePrinter: result.profile === "generic" ? (result.printer ?? null) : null,
      printerInfo: filamentChanges ? { ...printerInfo, filamentChanges } : undefined,
    });
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
