import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { and, eq } from "drizzle-orm";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { db } from "@/db";
import { modelFiles, models, type PrinterInfo } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { s3, S3_BUCKET } from "@/lib/s3";
import { stageBuffer } from "@/lib/storage";
import { reportError } from "@/lib/telemetry";
import { deleteS3Keys, ensureBaselineVersion, recordVersion } from "@/lib/model-versions";
import { bedSizeForModel } from "@/lib/printer-beds";
import { processPendingSlices } from "@/lib/slicer";
import { applyPrinterOverride, type PrinterOverride } from "@/lib/threemf-printer";

export const runtime = "nodejs";
// Rewriting a large archive means a full S3 download + re-zip + upload.
export const maxDuration = 300;

// Above this we skip the archive rewrite (the override still lands in the
// DB). Matches the slicer service's body cap — a file too big to slice gains
// nothing from patched-in settings.
const MAX_PATCH_BYTES = 256 * 1024 * 1024;

// Mirrors bedSizeFromPoints' plausibility range (threemf-slice-info.ts).
function cleanBedSize(raw: unknown): { x: number; y: number } | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const x = Math.round(Number((raw as { x?: unknown }).x));
  const y = Math.round(Number((raw as { y?: unknown }).y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  if (x < 20 || y < 20 || x > 2000 || y > 2000) return undefined;
  return { x, y };
}

function cleanNozzle(raw: unknown): number | undefined {
  if (raw == null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0.1 && value <= 2 ? value : undefined;
}

// Sets a .3mf file's printer profile to a user-chosen preset (issue #79):
// stores the override on model_files.printer_info, patches the archive's
// embedded slicer config where possible, and re-queues the file for slicing
// so estimates reflect the new profile. The patched bytes go to a NEW S3 key
// inside a versioned mutation — version snapshots reference the old key's
// bytes, which must stay immutable (and the threemf-remote parse cache is
// keyed by object key for the same reason).
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const model = await db.query.models.findFirst({ where: eq(models.id, id) });
  if (!model || model.deletedAt) {
    return NextResponse.json({ error: "Model not found" }, { status: 404 });
  }
  // Like the rest of editing, open to any signed-in user (collaborative
  // library): several people may each maintain the profile for their own
  // printer on the same model. The mutation is versioned, so it stays
  // revertable like any other edit.

  const body = (await req.json().catch(() => null)) as {
    fileId?: string;
    model?: string;
    nozzleDiameterMm?: number;
    bedSizeMm?: { x: number; y: number };
  } | null;
  const printerModel =
    typeof body?.model === "string" ? body.model.trim().slice(0, 80) : "";
  if (!body?.fileId || !printerModel) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const file = await db.query.modelFiles.findFirst({
    where: and(eq(modelFiles.id, body.fileId), eq(modelFiles.modelId, model.id)),
  });
  if (!file || file.kind !== "model" || !file.filename.toLowerCase().endsWith(".3mf")) {
    return NextResponse.json(
      { error: "Not a .3mf file of this model" },
      { status: 400 },
    );
  }

  const override: PrinterOverride = {
    model: printerModel,
    nozzleDiameterMm: cleanNozzle(body.nozzleDiameterMm),
    bedSizeMm: cleanBedSize(body.bedSizeMm),
  };

  // Patch the archive so downloads and "open in slicer" links carry the
  // chosen printer too. Best effort: an unpatchable file (not our JSON, too
  // large) still gets the DB override.
  let staged: Awaited<ReturnType<typeof stageBuffer>> | null = null;
  if (file.size <= MAX_PATCH_BYTES) {
    try {
      const object = await s3.send(
        new GetObjectCommand({ Bucket: S3_BUCKET, Key: file.s3Key }),
      );
      const bytes = object.Body ? await object.Body.transformToByteArray() : null;
      const patched = bytes && applyPrinterOverride(bytes, override);
      if (patched) {
        staged = await stageBuffer(file.filename, patched, file.contentType);
      }
    } catch (err) {
      reportError(`printer override could not patch ${file.filename}`, err);
    }
  }

  // Keep what the file itself told us (plate type, filaments) — the dialog
  // only overrides the printer identity.
  const printerInfo: PrinterInfo = {
    model: override.model,
    nozzleDiameterMm: override.nozzleDiameterMm,
    bedType: file.printerInfo?.bedType,
    filamentTypes: file.printerInfo?.filamentTypes,
    bedSizeMm: override.bedSizeMm ?? bedSizeForModel(override.model),
    override: true,
  };

  const s3KeysToDelete = await db.transaction(async (tx) => {
    await ensureBaselineVersion(tx, model.id, model.userId);
    await tx
      .update(modelFiles)
      .set({
        printerInfo,
        // A rewritten archive gets re-sliced so estimates reflect the new
        // profile; an unpatched one would just reproduce its old numbers.
        ...(staged
          ? {
              s3Key: staged.key,
              size: staged.size,
              sliceStatus: "pending" as const,
            }
          : {}),
      })
      .where(eq(modelFiles.id, file.id));
    const pruned = await recordVersion(tx, model.id, session.user.id, "edit");
    // Generated variants are excluded from snapshots, so a replaced variant
    // archive would orphan its old object — delete it. Non-variant old keys
    // stay: earlier snapshots still reference them.
    const variantKey =
      staged && file.generatedFromId !== null ? [file.s3Key] : [];
    return [...variantKey, ...pruned];
  });
  await deleteS3Keys(s3KeysToDelete);

  if (staged) after(() => processPendingSlices(model.id));
  revalidatePath(`/models/${model.id}`);
  return NextResponse.json({
    status: "ok",
    patched: staged !== null,
    printerInfo,
    size: staged?.size ?? file.size,
  });
}
