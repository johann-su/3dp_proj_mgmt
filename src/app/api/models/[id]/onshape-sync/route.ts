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
  eligibleExportElements,
  exportPinnedModels,
  getCurrentMicroversion,
  getElements,
  MAX_EXPORT_ELEMENTS,
  onshapeAuthHeaders,
  OnshapeError,
  parseOnshapeUrl,
  planOnshapeSync,
  type OnshapeExport,
  type OnshapeExportElement,
} from "@/lib/onshape/api";

export const runtime = "nodejs";
// 3MF exports are asynchronous on Onshape's side and can take a while.
export const maxDuration = 300;

// Re-exports the model's Onshape source and replaces the files that came from
// Onshape (modelFiles.onshapeElementId). Only workspace pins can change;
// version pins are immutable snapshots and are reported as up to date.
//
// Two-phase like the MakerWorld/Printables source sync: a POST without a
// body is the preview — when the document has Part Studio/Assembly tabs the
// model doesn't carry yet, it answers `needs-selection` with those tabs and
// the client re-POSTs with the picked `addElementIds` (empty = decline).
// Without new tabs the preview applies directly, as before.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    addElementIds?: string[];
  } | null;
  const addElementIds = Array.isArray(body?.addElementIds)
    ? body.addElementIds.filter((v): v is string => typeof v === "string")
    : null;

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
  // Captured as a const so the narrowing (guarded non-null above) survives into
  // the eligibleElements closure below — `pin` is a let, so TS resets it there.
  const wvmId = pin.wvmId;

  const accessToken = await getOnshapeAccessToken(session.user.id);
  if (!accessToken) {
    return NextResponse.json(
      { error: "Sign in with Onshape under Settings → Onshape first" },
      { status: 400 },
    );
  }
  const auth = { accessToken };

  try {
    // Read the workspace microversion before exporting so a concurrent edit
    // makes the stored value stale (next sync re-runs) instead of being
    // skipped. It moves on *any* document change, so it is only a coarse "did
    // anything at all change" gate — the per-tab diff below decides what to
    // actually re-export (issue #70).
    const microversion = await getCurrentMicroversion(
      auth,
      pin.documentId,
      wvm,
      wvmId,
    );
    const microversionChanged =
      !microversion || microversion !== model.onshapeMicroversion;

    // The tabs this model was imported with, each with the per-element
    // microversion stored on its file (sourceModifiedAt). One entry per element
    // id (keeping the first file's token). Empty for models whose files carry
    // no element ids (all Onshape files removed, or an import predating the
    // feature) — those fall back to the pin/all export.
    const importedByElement = new Map<string, string | null>();
    for (const f of model.files) {
      if (f.onshapeElementId && !importedByElement.has(f.onshapeElementId)) {
        importedByElement.set(f.onshapeElementId, f.sourceModifiedAt);
      }
    }
    const importedElementIds = [...importedByElement.keys()];

    // The document's current export tabs, listed at most once and shared by the
    // new-tab offer and the per-tab diff.
    let eligibleCache: OnshapeExportElement[] | null = null;
    const eligibleElements = async () => {
      if (!eligibleCache) {
        eligibleCache = eligibleExportElements(
          await getElements(auth, pin.documentId, wvm, wvmId),
        );
      }
      return eligibleCache;
    };

    if (addElementIds === null) {
      // Preview: offer tabs added upstream since the import. Skipped for
      // models without element ids (no baseline to diff against) and models
      // already at the export cap. This check runs even when the microversion
      // is unchanged, so a tab declined in an earlier sync can still be added
      // later — the dialog is the only way to grow an existing model's tab set
      // without re-importing.
      const maxAdd = MAX_EXPORT_ELEMENTS - importedElementIds.length;
      if (importedElementIds.length > 0 && maxAdd > 0) {
        const imported = new Set(importedElementIds);
        const newTabs = (await eligibleElements()).filter(
          (e) => !imported.has(e.id),
        );
        if (newTabs.length > 0) {
          return NextResponse.json({
            status: "needs-selection",
            newTabs,
            microversionChanged,
            maxAdd,
          });
        }
      }
      // Nothing in the workspace moved ⇒ no imported tab moved either (the
      // workspace microversion is a superset of every element's), so there is
      // nothing to export.
      if (!microversionChanged) {
        return NextResponse.json({
          status: "up-to-date",
          message: "Already up to date with Onshape.",
        });
      }
    } else if (addElementIds.length === 0 && !microversionChanged) {
      // Apply that declined every new tab on an otherwise unchanged document.
      return NextResponse.json({
        status: "up-to-date",
        message: "Already up to date with Onshape.",
      });
    }

    // Decide which tabs to re-export and which existing rows to drop. Unchanged
    // tabs keep their rows and S3 keys untouched, so no version is recorded for
    // them. `dropElementIds === null` means "no per-tab baseline": replace
    // every Onshape file via the pin/all fallback.
    let exportSelection: string[] | null;
    let dropElementIds: Set<string> | null;
    const syncWarnings: string[] = [];

    if (importedElementIds.length === 0) {
      exportSelection = null; // pin/all fallback
      dropElementIds = null; // replace whatever Onshape files remain
    } else {
      const { changedIds, deletedIds } = planOnshapeSync(
        [...importedByElement].map(([elementId, mv]) => ({
          elementId,
          microversion: mv,
        })),
        await eligibleElements(),
      );
      exportSelection = [...new Set([...changedIds, ...(addElementIds ?? [])])];
      dropElementIds = new Set([...changedIds, ...deletedIds]);

      if (deletedIds.length > 0) {
        const gone = model.files
          .filter(
            (f) => f.onshapeElementId && deletedIds.includes(f.onshapeElementId),
          )
          .map((f) => f.filename);
        syncWarnings.push(
          `${deletedIds.length} imported Onshape tab(s) no longer exist upstream and were removed: ${gone.join(", ")}.`,
        );
      }

      if (exportSelection.length === 0 && deletedIds.length === 0) {
        // Only unimported tabs / a drawing / a Variable Studio moved. Advance
        // the stored workspace microversion so the next sync short-circuits on
        // the coarse gate, but record no version and touch no files (mirrors
        // the source-sync "toStamp" bookkeeping).
        if (microversion !== model.onshapeMicroversion) {
          await db
            .update(models)
            .set({ onshapeMicroversion: microversion })
            .where(eq(models.id, model.id));
        }
        return NextResponse.json({
          status: "up-to-date",
          message: "Already up to date with Onshape.",
        });
      }
    }

    // Export the changed/added tabs — nothing to export when only deletions
    // remain (rows are dropped in the transaction below).
    const { exports, warnings } =
      exportSelection === null || exportSelection.length > 0
        ? await exportPinnedModels(
            auth,
            {
              documentId: pin.documentId,
              wvm,
              wvmId,
              elementId: pin.elementId,
            },
            exportSelection,
            await eligibleElements(),
          )
        : { exports: [] as OnshapeExport[], warnings: [] as string[] };

    // Stage every export before touching the database: replacing the files is
    // all-or-nothing so a mid-way failure can't leave the model half-synced.
    const headers = onshapeAuthHeaders(auth);
    const staged: {
      elementId: string;
      microversionId?: string;
      file: Awaited<ReturnType<typeof stageBuffer>>;
    }[] = [];
    for (const file of exports) {
      const res = await fetch(file.url, { headers, redirect: "follow" });
      if (!res.ok || !res.body) {
        throw new OnshapeError(`Download failed for ${file.filename} (${res.status})`);
      }
      // Onshape exports 3MF in meters centered on the origin; normalize to
      // millimeters on the plate so slicers (ours and the user's) accept it.
      staged.push({
        elementId: file.elementId,
        microversionId: file.microversionId,
        file: await stageBuffer(
          file.filename,
          normalizeThreeMf(new Uint8Array(await res.arrayBuffer())),
          "model/3mf",
        ),
      });
    }

    // Only the tabs we re-exported (or that were deleted upstream) are
    // replaced; every unchanged tab keeps its row and S3 key. The fallback
    // (dropElementIds null) replaces all Onshape files, as before.
    const replaced = model.files.filter(
      (f) =>
        f.onshapeElementId !== null &&
        (dropElementIds === null || dropElementIds.has(f.onshapeElementId)),
    );
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
      if (staged.length > 0) {
        await tx.insert(modelFiles).values(
          staged.map(({ elementId, microversionId, file }) => ({
            modelId: model.id,
            kind: "model" as const,
            filename: file.filename,
            s3Key: file.key,
            size: file.size,
            contentType: file.contentType,
            position: position++,
            onshapeElementId: elementId,
            imported: true,
            // Per-element microversion (issue #70): stored in the shared
            // sourceModifiedAt token slot so the next sync can skip this tab
            // when it hasn't moved. Onshape files never take part in the
            // MakerWorld/Printables source sync.
            sourceModifiedAt: microversionId ?? null,
            contentHash: file.contentHash,
            // Newly exported 3MF files still need slice estimates; the model
            // page runs processPendingSlices in the background on next view.
            sliceStatus: sliceEligible("model", file.filename)
              ? ("pending" as const)
              : null,
          })),
        );
      }
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
      warnings: [...syncWarnings, ...warnings],
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
