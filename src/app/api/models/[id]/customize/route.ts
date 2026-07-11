import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { db } from "@/db";
import { modelFiles, models } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { s3, S3_BUCKET } from "@/lib/s3";
import { stageBuffer } from "@/lib/storage";
import { normalizeThreeMf } from "@/lib/threemf-normalize";
import { sliceEligible, processPendingSlices } from "@/lib/slicer";
import { renderScad } from "@/lib/openscad";
import { prepareScadRender } from "./render-request";

export const runtime = "nodejs";
// Rendering waits on the OpenSCAD service (2 min timeout plus queueing).
export const maxDuration = 300;

// Generated variants a single .scad file may accumulate before we ask the
// owner to clean up — a hard stop against unbounded S3/DB growth.
const MAX_VARIANTS_PER_SOURCE = 20;

function paramsHash(parameters: Record<string, string>): string {
  const canonical = Object.entries(parameters).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// "<base> (arm_count=4, length=30).3mf", falling back to a short hash when
// there are no overrides or the summary would blow past a sane length.
function variantFilename(
  sourceFilename: string,
  parameters: Record<string, string>,
  hash: string,
): string {
  const base = sourceFilename.replace(/\.scad$/i, "");
  const summary = Object.entries(parameters)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  const suffix = summary && summary.length <= 80 ? summary : hash.slice(0, 8);
  return `${base} (${suffix}).3mf`.slice(0, 255);
}

// Renders a parametric .scad model file with the submitted customizer values
// and stores the result as a generated .3mf variant of that file. Identical
// parameter sets return the existing variant instead of re-rendering.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const request = await prepareScadRender(id, await req.json().catch(() => null));
  if ("error" in request) {
    return NextResponse.json({ error: request.error }, { status: request.status });
  }
  const { model, source, scadSource, values } = request;
  const hash = paramsHash(values);

  const existing = model.files.find(
    (f) => f.generatedFromId === source.id && f.generatedParamsHash === hash,
  );
  if (existing) {
    return NextResponse.json({
      status: "exists",
      fileId: existing.id,
      filename: existing.filename,
    });
  }

  const variantCount = model.files.filter(
    (f) => f.generatedFromId === source.id,
  ).length;
  if (variantCount >= MAX_VARIANTS_PER_SOURCE) {
    return NextResponse.json(
      {
        error: `This file already has ${MAX_VARIANTS_PER_SOURCE} generated variants — delete one first.`,
      },
      { status: 409 },
    );
  }

  const rendered = await renderScad(scadSource, values);
  if (!rendered.ok) {
    const status = rendered.status === 422 ? 422 : 502;
    return NextResponse.json({ error: rendered.error }, { status });
  }

  // OpenSCAD writes millimeter coordinates but centers the mesh on the
  // origin; normalize onto the plate like Onshape exports so slicers (ours
  // and the user's) accept it.
  const filename = variantFilename(source.filename, values, hash);
  const staged = await stageBuffer(
    filename,
    normalizeThreeMf(rendered.data),
    "model/3mf",
  );

  const position = Math.max(0, ...model.files.map((f) => f.position + 1));
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
      generatedFromId: source.id,
      generatedParams: values,
      generatedParamsHash: hash,
      sliceStatus: sliceEligible("model", staged.filename)
        ? ("pending" as const)
        : null,
    })
    .returning({ id: modelFiles.id });

  after(() => processPendingSlices(model.id));
  revalidatePath(`/models/${model.id}`);
  return NextResponse.json({
    status: "created",
    fileId: inserted.id,
    filename: staged.filename,
  });
}

// Deletes one generated variant (never the .scad source itself — that goes
// through the regular edit flow, which also removes its variants).
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
  if (!model) {
    return NextResponse.json({ error: "Model not found" }, { status: 404 });
  }
  if (model.userId !== session.user.id) {
    return NextResponse.json({ error: "Not your model" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { fileId?: string } | null;
  if (!body?.fileId) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const file = await db.query.modelFiles.findFirst({
    where: and(eq(modelFiles.id, body.fileId), eq(modelFiles.modelId, model.id)),
  });
  if (!file || file.generatedFromId === null) {
    return NextResponse.json(
      { error: "Not a generated variant of this model" },
      { status: 400 },
    );
  }

  await db.delete(modelFiles).where(eq(modelFiles.id, file.id));
  await s3.send(
    new DeleteObjectsCommand({
      Bucket: S3_BUCKET,
      Delete: { Objects: [{ Key: file.s3Key }] },
    }),
  );

  revalidatePath(`/models/${model.id}`);
  return NextResponse.json({ status: "deleted" });
}
