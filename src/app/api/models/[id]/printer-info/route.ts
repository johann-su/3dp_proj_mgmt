import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { db } from "@/db";
import { modelFiles, models, type PrinterInfo } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { s3, S3_BUCKET } from "@/lib/s3";
import { stageBuffer } from "@/lib/storage";
import { reportError } from "@/lib/telemetry";
import { deleteS3Keys, ensureBaselineVersion, recordVersion } from "@/lib/model-versions";
import { bedSizeForModel } from "@/lib/printer-beds";
import { derivativeFilename } from "@/lib/printer-presets";
import { processPendingSlices } from "@/lib/slicer";
import { applyPrinterOverride, type PrinterOverride } from "@/lib/threemf-printer";

// Per-file printer profiles (issue #79). Three operations, all open to any
// signed-in user like the rest of editing (several people may each maintain
// the profile for their own printer on one model):
//
//   PATCH   override the printer a stored .3mf itself is meant for
//   POST    add a printer *derivative* — a copy of the .3mf patched for
//           another machine, stored as a generated file under the source
//   DELETE  remove such a derivative again

export const runtime = "nodejs";
// Rewriting a large archive means a full S3 download + re-zip + upload.
export const maxDuration = 300;

// Above this we skip the archive rewrite (a PATCH still lands in the DB, a
// POST is rejected — a byte-identical copy of a huge file helps nobody).
// Matches the slicer service's body cap.
const MAX_PATCH_BYTES = 256 * 1024 * 1024;

// Derivatives one .3mf may accumulate — same hard stop against unbounded
// S3/DB growth as the customizer's variants.
const MAX_DERIVATIVES_PER_SOURCE = 20;

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

type OverrideBody = {
  fileId?: string;
  model?: string;
  nozzleDiameterMm?: number;
  bedSizeMm?: { x: number; y: number };
};

// Shared request plumbing for PATCH/POST: session, live model, a .3mf file of
// that model, and a validated printer override. Returns a NextResponse on any
// failure.
async function prepareOverrideRequest(req: NextRequest, modelId: string) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const model = await db.query.models.findFirst({ where: eq(models.id, modelId) });
  if (!model || model.deletedAt) {
    return NextResponse.json({ error: "Model not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => null)) as OverrideBody | null;
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
  return { session, model, file, override };
}

// Downloads the file's bytes and applies the override. Null when the archive
// can't be patched (too large, unreadable, foreign content).
async function patchArchive(
  file: { s3Key: string; size: number; filename: string },
  override: PrinterOverride,
): Promise<Uint8Array | null> {
  if (file.size > MAX_PATCH_BYTES) return null;
  try {
    const object = await s3.send(
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: file.s3Key }),
    );
    const bytes = object.Body ? await object.Body.transformToByteArray() : null;
    return bytes ? applyPrinterOverride(bytes, override) : null;
  } catch (err) {
    reportError(`printer override could not patch ${file.filename}`, err);
    return null;
  }
}

// The stored profile for an override: the chosen printer identity, keeping
// what the file itself told us (plate type, filaments).
function overrideInfo(
  override: PrinterOverride,
  previous: PrinterInfo | null,
): PrinterInfo {
  return {
    model: override.model,
    nozzleDiameterMm: override.nozzleDiameterMm,
    bedType: previous?.bedType,
    filamentTypes: previous?.filamentTypes,
    bedSizeMm: override.bedSizeMm ?? bedSizeForModel(override.model),
    override: true,
  };
}

// Sets a .3mf file's own printer profile: stores the override on
// model_files.printer_info, patches the archive where possible, and re-queues
// slicing so estimates reflect the new profile. Patched bytes go to a NEW S3
// key inside a versioned mutation — version snapshots reference the old key's
// bytes, which must stay immutable (and the threemf-remote parse cache is
// keyed by object key for the same reason).
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const prepared = await prepareOverrideRequest(req, id);
  if (prepared instanceof NextResponse) return prepared;
  const { session, model, file, override } = prepared;

  const patched = await patchArchive(file, override);
  const staged = patched
    ? await stageBuffer(file.filename, patched, file.contentType)
    : null;
  const printerInfo = overrideInfo(override, file.printerInfo ?? null);

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
    // Generated files are excluded from snapshots, so a replaced generated
    // archive would orphan its old object — delete it. Non-generated old
    // keys stay: earlier snapshots still reference them.
    const generatedKey =
      staged && file.generatedFromId !== null ? [file.s3Key] : [];
    return [...generatedKey, ...pruned];
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

// Adds a printer derivative: a copy of the source .3mf patched for another
// machine, named "<base>_<printer>_<nozzle>.3mf" and stored as a generated
// file (generated_from_id → source) so it nests under the source everywhere,
// cascades away with it, and stays out of version snapshots — exactly like
// the customizer's variants, whose lifecycle rules it reuses.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const prepared = await prepareOverrideRequest(req, id);
  if (prepared instanceof NextResponse) return prepared;
  const { session, model, file, override } = prepared;

  if (file.generatedFromId !== null) {
    return NextResponse.json(
      { error: "Add printers on the original file, not a derivative" },
      { status: 400 },
    );
  }
  if (file.size > MAX_PATCH_BYTES) {
    return NextResponse.json(
      { error: "File too large to copy for another printer" },
      { status: 413 },
    );
  }

  const siblings = await db.query.modelFiles.findMany({
    where: eq(modelFiles.generatedFromId, file.id),
    columns: { filename: true },
  });
  if (siblings.length >= MAX_DERIVATIVES_PER_SOURCE) {
    return NextResponse.json(
      {
        error: `This file already has ${MAX_DERIVATIVES_PER_SOURCE} printer derivatives — remove one first.`,
      },
      { status: 409 },
    );
  }
  const filename = derivativeFilename(
    file.filename,
    override.model,
    override.nozzleDiameterMm,
  );
  if (siblings.some((s) => s.filename === filename)) {
    return NextResponse.json(
      { error: `${filename} already exists for this file.` },
      { status: 409 },
    );
  }

  const patched = await patchArchive(file, override);
  if (!patched) {
    return NextResponse.json(
      { error: "The file could not be prepared for another printer" },
      { status: 422 },
    );
  }
  const staged = await stageBuffer(filename, patched, file.contentType);
  const printerInfo = overrideInfo(override, file.printerInfo ?? null);

  const position =
    (await db.query.modelFiles.findMany({
      where: eq(modelFiles.modelId, model.id),
      columns: { position: true },
    })).reduce((max, f) => Math.max(max, f.position + 1), 0);
  const [inserted] = await db
    .insert(modelFiles)
    .values({
      modelId: model.id,
      kind: "model" as const,
      filename: staged.filename,
      s3Key: staged.key,
      size: staged.size,
      contentType: staged.contentType,
      position,
      generatedFromId: file.id,
      generatedBy: session.user.id,
      printerInfo,
      sliceStatus: "pending" as const,
    })
    .returning({ id: modelFiles.id });

  after(() => processPendingSlices(model.id));
  revalidatePath(`/models/${model.id}`);
  return NextResponse.json({
    status: "created",
    file: {
      id: inserted.id,
      filename: staged.filename,
      size: staged.size,
      printerInfo,
    },
  });
}

// Removes a printer derivative (never the source file — that goes through the
// regular edit flow, which also removes its derivatives). Scad-generated
// variants are not deletable here: they keep the customizer route's
// owner-or-generator gate, distinguished by their generated_params_hash.
export async function DELETE(
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

  const body = (await req.json().catch(() => null)) as { fileId?: string } | null;
  if (!body?.fileId) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const file = await db.query.modelFiles.findFirst({
    where: and(
      eq(modelFiles.id, body.fileId),
      eq(modelFiles.modelId, model.id),
      isNull(modelFiles.generatedParamsHash),
    ),
  });
  if (!file || file.generatedFromId === null) {
    return NextResponse.json(
      { error: "Not a printer derivative of this model" },
      { status: 400 },
    );
  }

  // Derivatives are never referenced by version snapshots, so the bytes go
  // with the row (same as the customizer's variant delete).
  await db.delete(modelFiles).where(eq(modelFiles.id, file.id));
  await deleteS3Keys([file.s3Key]);

  revalidatePath(`/models/${model.id}`);
  return NextResponse.json({ status: "deleted" });
}
