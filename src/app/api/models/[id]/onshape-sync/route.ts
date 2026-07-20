import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { modelFiles, models } from "@/db/schema";
import { getSession } from "@/lib/auth";
import {
  deleteS3Keys,
  ensureBaselineVersion,
  recordVersion,
} from "@/lib/model-versions";
import { stageBuffer } from "@/lib/storage";
import { normalizeThreeMf } from "@/lib/threemf-normalize";
import { sliceEligible } from "@/lib/slicer";
import { reportError } from "@/lib/telemetry";
import { getOnshapeAccessToken } from "@/lib/onshape/credentials";
import {
  exportPinnedModels,
  getCurrentMicroversion,
  onshapeAuthHeaders,
  OnshapeError,
  parseOnshapeUrl,
} from "@/lib/onshape/api";

export const runtime = "nodejs";
// 3MF exports are asynchronous on Onshape's side and can take a while.
export const maxDuration = 300;

// Re-exports the model's Onshape source and replaces the files that came from
// Onshape (modelFiles.onshapeElementId). Only workspace pins can change;
// version pins are immutable snapshots and are reported as up to date.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const model = await db.query.models.findFirst({
    where: eq(models.id, id),
    with: { files: true },
  });
  if (!model || model.deletedAt) {
    return NextResponse.json({ error: "Model not found" }, { status: 404 });
  }
  // Syncing re-exports the model's files, so it counts as editing — open to any
  // signed-in user (uses their own Onshape connection, which must have access
  // to the linked document). Only deletion is owner-gated.

  let pin = null;
  try {
    pin = model.sourceUrl ? parseOnshapeUrl(new URL(model.sourceUrl)) : null;
  } catch {
    // malformed sourceUrl — handled below
  }
  if (!pin || pin.wvm === "m" || !pin.wvmId) {
    return NextResponse.json(
      { error: "This model is not linked to an Onshape document" },
      { status: 400 },
    );
  }
  if (pin.wvm === "v") {
    return NextResponse.json({
      status: "up-to-date",
      message: "Pinned to an Onshape version — versions never change.",
    });
  }
  const wvm = pin.wvm as "w";

  const accessToken = await getOnshapeAccessToken(session.user.id);
  if (!accessToken) {
    return NextResponse.json(
      { error: "Sign in with Onshape under Settings → Onshape first" },
      { status: 400 },
    );
  }
  const auth = { accessToken };

  try {
    // Read the microversion before exporting so a concurrent edit makes the
    // stored value stale (next sync re-runs) instead of being skipped.
    const microversion = await getCurrentMicroversion(
      auth,
      pin.documentId,
      wvm,
      pin.wvmId,
    );
    if (microversion && microversion === model.onshapeMicroversion) {
      return NextResponse.json({
        status: "up-to-date",
        message: "Already up to date with Onshape.",
      });
    }

    // Re-export the tabs this model was actually imported with (the import
    // dialog lets users pick a subset — e.g. Part Studios but not the
    // Assembly), not whatever the URL pin would select today. Falls back to
    // pin behavior for models whose Onshape files were all removed.
    const importedElementIds = [
      ...new Set(
        model.files
          .map((f) => f.onshapeElementId)
          .filter((v): v is string => v !== null),
      ),
    ];
    const { exports, warnings } = await exportPinnedModels(
      auth,
      {
        documentId: pin.documentId,
        wvm,
        wvmId: pin.wvmId,
        elementId: pin.elementId,
      },
      importedElementIds.length > 0 ? importedElementIds : null,
    );

    // Stage every export before touching the database: replacing the files is
    // all-or-nothing so a mid-way failure can't leave the model half-synced.
    const headers = onshapeAuthHeaders(auth);
    const staged: { elementId: string; file: Awaited<ReturnType<typeof stageBuffer>> }[] =
      [];
    for (const file of exports) {
      const res = await fetch(file.url, { headers, redirect: "follow" });
      if (!res.ok || !res.body) {
        throw new OnshapeError(`Download failed for ${file.filename} (${res.status})`);
      }
      // Onshape exports 3MF in meters centered on the origin; normalize to
      // millimeters on the plate so slicers (ours and the user's) accept it.
      staged.push({
        elementId: file.elementId,
        file: await stageBuffer(
          file.filename,
          normalizeThreeMf(new Uint8Array(await res.arrayBuffer())),
          "model/3mf",
        ),
      });
    }

    const replaced = model.files.filter((f) => f.onshapeElementId !== null);
    const s3KeysToDelete = await db.transaction(async (tx) => {
      // A bad sync used to destroy the last good export — now the pre-sync
      // state becomes a version first, so it stays revertable (issue #55).
      await ensureBaselineVersion(tx, model.id, model.userId);
      if (replaced.length > 0) {
        await tx.delete(modelFiles).where(
          inArray(
            modelFiles.id,
            replaced.map((f) => f.id),
          ),
        );
      }
      let position = Math.max(0, ...model.files.map((f) => f.position + 1));
      await tx.insert(modelFiles).values(
        staged.map(({ elementId, file }) => ({
          modelId: model.id,
          kind: "model" as const,
          filename: file.filename,
          s3Key: file.key,
          size: file.size,
          contentType: file.contentType,
          position: position++,
          onshapeElementId: elementId,
          imported: true,
          // Newly exported 3MF files still need slice estimates; the model page
          // runs processPendingSlices in the background on next view.
          sliceStatus: sliceEligible("model", file.filename)
            ? ("pending" as const)
            : null,
        })),
      );
      await tx
        .update(models)
        .set({ onshapeMicroversion: microversion, updatedAt: new Date() })
        .where(eq(models.id, model.id));

      // The replaced exports keep their S3 objects — the pre-sync version
      // still references them. Only keys orphaned by version pruning go.
      return recordVersion(tx, model.id, session.user.id, "onshape-sync");
    });

    await deleteS3Keys(s3KeysToDelete);

    revalidatePath(`/models/${model.id}`);
    revalidatePath("/");
    return NextResponse.json({
      status: "updated",
      files: staged.map(({ file }) => file.filename),
      warnings,
    });
  } catch (err) {
    if (err instanceof OnshapeError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    reportError("Onshape sync failed", err);
    return NextResponse.json(
      { error: "Sync failed — try again in a moment" },
      { status: 500 },
    );
  }
}
