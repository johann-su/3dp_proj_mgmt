import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { modelFiles, models } from "@/db/schema";
import { getSession } from "@/lib/auth";
import {
  deleteS3Keys,
  ensureBaselineVersion,
  recordVersion,
} from "@/lib/model-versions";
import { processPendingSlices, sliceEligible } from "@/lib/slicer";
import { reportError } from "@/lib/telemetry";
import { getBambuCredential } from "@/lib/bambu/credentials";
import {
  fetchProfileDownload,
  fetchRawModelDownload,
  type BambuRegion,
} from "@/lib/bambu/cloud";
import { ImportError, type RemoteAsset } from "@/lib/import/types";
import { stageImportedAssets } from "@/lib/import/stage";
import {
  BAMBU_EXPIRED_WARNING,
  ensure3mf,
  fetchMakerworldDesign,
  listMakerworldUpstreamFiles,
  parseMakerworldUrl,
  type MakerworldUpstreamFile,
} from "@/lib/import/makerworld";
import {
  downloadLink,
  fetchPrintablesPrint,
  listPrintablesUpstreamFiles,
  parsePrintablesUrl,
  type PrintablesUpstreamFile,
} from "@/lib/import/printables";
import {
  computeSyncPlan,
  planIsEmpty,
  type SyncPlan,
} from "@/lib/import/sync-diff";

export const runtime = "nodejs";
// Confirming a sync can download many print profiles.
export const maxDuration = 300;

// "Sync from MakerWorld/Printables": diffs the model's imported files against
// the platform's current file list (see src/lib/import/sync-diff.ts for the
// contract — imported files mirror upstream, manual files and metadata are
// never touched). POST without `confirm` answers with a preview of the plan;
// POST {confirm:true} downloads the new/changed files and applies it, with
// the pre-sync state kept as a version (like Onshape sync). Open to any
// signed-in user, like editing.
export async function POST(
  req: NextRequest,
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

  const body = (await req.json().catch(() => null)) as { confirm?: boolean } | null;
  const confirm = body?.confirm === true;

  let sourceUrl: URL | null = null;
  try {
    sourceUrl = model.sourceUrl ? new URL(model.sourceUrl) : null;
  } catch {
    // malformed sourceUrl — handled below
  }
  const makerworldId = sourceUrl ? parseMakerworldUrl(sourceUrl) : null;
  const printablesId = sourceUrl && !makerworldId ? parsePrintablesUrl(sourceUrl) : null;
  if (!makerworldId && !printablesId) {
    return NextResponse.json(
      { error: "This model is not linked to a MakerWorld or Printables source" },
      { status: 400 },
    );
  }

  try {
    // The user's own Bambu connection drives MakerWorld downloads (and the
    // API region); Printables needs no account.
    const cred = makerworldId ? await getBambuCredential(session.user.id) : null;
    const region: BambuRegion = cred?.region ?? "global";

    let upstream: (MakerworldUpstreamFile | PrintablesUpstreamFile)[];
    let design: Awaited<ReturnType<typeof fetchMakerworldDesign>> | null = null;
    if (makerworldId) {
      design = await fetchMakerworldDesign(makerworldId, region);
      upstream = listMakerworldUpstreamFiles(design);
    } else {
      upstream = listPrintablesUpstreamFiles(await fetchPrintablesPrint(printablesId!));
    }

    const plan = computeSyncPlan(model.files, upstream);

    if (planIsEmpty(plan)) {
      // Bookkeeping only: refresh stale ids/tokens (adopted legacy imports)
      // so the next diff is cheap. Not a content change — no version row.
      for (const stamp of plan.toStamp) {
        await db
          .update(modelFiles)
          .set({
            sourceFileId: stamp.sourceFileId,
            sourceModifiedAt: stamp.sourceModifiedAt,
          })
          .where(eq(modelFiles.id, stamp.localId));
      }
      return NextResponse.json({
        status: "up-to-date",
        message: `Already up to date with ${makerworldId ? "MakerWorld" : "Printables"}.`,
      });
    }

    // MakerWorld profile/scad downloads need a connected Bambu account; docs
    // and the whole Printables flow don't.
    const needsBambu =
      makerworldId !== null &&
      [...plan.toImport, ...plan.toReplace.map((r) => r.upstream)].some(
        (u) => "group" in u && (u.group === "profile" || u.group === "scad"),
      );
    if (needsBambu && !cred) {
      return NextResponse.json(
        {
          error:
            "Syncing MakerWorld files needs a connected Bambu account — connect it in Settings → Bambu Cloud first",
        },
        { status: 400 },
      );
    }

    if (!confirm) {
      return NextResponse.json({
        status: "preview",
        source: makerworldId ? "MakerWorld" : "Printables",
        toImport: plan.toImport.map((u) => u.filename),
        toReplace: plan.toReplace.map((r) => r.local.filename),
        toRemove: plan.toRemove.map((f) => f.filename),
      });
    }

    const { assets, downloadWarnings } = makerworldId
      ? await buildMakerworldAssets(
          plan as SyncPlan<MakerworldUpstreamFile>,
          design!,
          cred!,
        )
      : await buildPrintablesAssets(plan as SyncPlan<PrintablesUpstreamFile>, printablesId!);

    const staged = await stageImportedAssets({ assets });
    const warnings = [...downloadWarnings, ...staged.warnings];
    if (assets.length > 0 && staged.files.length === 0) {
      // Every download failed — don't touch the model based on nothing.
      return NextResponse.json(
        { error: warnings[0] ?? "Downloads failed — try again in a moment" },
        { status: 502 },
      );
    }

    // Apply: staged files upsert into the imported set (replacing their
    // matched row in place, keeping its position), planned removals drop
    // whatever staging didn't already replace. Replaced/removed rows keep
    // their S3 objects — the pre-sync version still references them; only
    // generated variants (cascaded away with their .scad source) and keys
    // orphaned by version pruning are deleted.
    const importedSet = model.files.filter(
      (f) =>
        f.imported &&
        f.generatedFromId === null &&
        (f.kind === "model" || f.kind === "pdf"),
    );
    const localById = new Map(
      importedSet.filter((f) => f.sourceFileId !== null).map((f) => [f.sourceFileId, f]),
    );
    const adoptable = new Map(
      importedSet
        .filter((f) => f.sourceFileId === null)
        .reverse()
        .map((f) => [f.filename, f]),
    );

    let importedCount = 0;
    let updatedCount = 0;
    const s3KeysToDelete = await db.transaction(async (tx) => {
      await ensureBaselineVersion(tx, model.id, model.userId);

      const deletedIds = new Set<string>();
      let nextPosition = Math.max(0, ...model.files.map((f) => f.position + 1));

      for (const file of staged.files) {
        let target = file.sourceFileId ? localById.get(file.sourceFileId) : undefined;
        if (!target) {
          target = adoptable.get(file.filename);
          if (target) adoptable.delete(file.filename);
        }
        if (target) {
          if (localById.get(target.sourceFileId) === target) {
            localById.delete(target.sourceFileId);
          }
          await tx.delete(modelFiles).where(eq(modelFiles.id, target.id));
          deletedIds.add(target.id);
          updatedCount++;
        } else {
          importedCount++;
        }
        await tx.insert(modelFiles).values({
          modelId: model.id,
          kind: file.kind,
          filename: file.filename,
          s3Key: file.key,
          size: file.size,
          contentType: file.contentType,
          position: target ? target.position : nextPosition++,
          imported: true,
          sourceFileId: file.sourceFileId ?? null,
          sourceModifiedAt: file.sourceModifiedAt ?? null,
          contentHash: file.kind === "model" ? file.contentHash : null,
          sliceStatus: sliceEligible(file.kind, file.filename)
            ? ("pending" as const)
            : null,
        });
      }

      const removeIds = plan.toRemove
        .map((f) => f.id)
        .filter((fileId) => !deletedIds.has(fileId));
      if (removeIds.length > 0) {
        await tx.delete(modelFiles).where(inArray(modelFiles.id, removeIds));
        for (const fileId of removeIds) deletedIds.add(fileId);
      }

      for (const stamp of plan.toStamp) {
        if (deletedIds.has(stamp.localId)) continue;
        await tx
          .update(modelFiles)
          .set({
            sourceFileId: stamp.sourceFileId,
            sourceModifiedAt: stamp.sourceModifiedAt,
          })
          .where(eq(modelFiles.id, stamp.localId));
      }

      await tx
        .update(models)
        .set({ updatedAt: new Date() })
        .where(eq(models.id, model.id));

      // Variants of a replaced/removed .scad cascade away with their source;
      // snapshots never reference them, so their bytes go now.
      const variantKeys = model.files
        .filter((f) => f.generatedFromId !== null && deletedIds.has(f.generatedFromId))
        .map((f) => f.s3Key);
      const pruned = await recordVersion(tx, model.id, session.user.id, "source-sync");
      return [...variantKeys, ...pruned];
    });

    await deleteS3Keys(s3KeysToDelete);

    // Freshly imported/replaced .3mf files need slice estimates.
    after(() => processPendingSlices(model.id));

    revalidatePath(`/models/${model.id}`);
    revalidatePath("/");
    return NextResponse.json({
      status: "updated",
      imported: importedCount,
      updated: updatedCount,
      removed: plan.toRemove.length,
      warnings,
    });
  } catch (err) {
    if (err instanceof ImportError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    reportError("Source sync failed", err);
    return NextResponse.json(
      { error: "Sync failed — try again in a moment" },
      { status: 500 },
    );
  }
}

// Resolves download URLs for the MakerWorld files the plan wants: each print
// profile individually, all .scad sources via the single raw-files zip, docs
// directly. Failed resolutions become warnings (the matched local row simply
// stays); an expired login aborts the whole sync.
async function buildMakerworldAssets(
  plan: SyncPlan<MakerworldUpstreamFile>,
  design: Awaited<ReturnType<typeof fetchMakerworldDesign>>,
  cred: { token: string; region: BambuRegion },
): Promise<{ assets: RemoteAsset[]; downloadWarnings: string[] }> {
  const wanted = [...plan.toImport, ...plan.toReplace.map((r) => r.upstream)];
  const assets: RemoteAsset[] = [];
  const downloadWarnings: string[] = [];

  for (const entry of wanted) {
    if (entry.group !== "profile") continue;
    if (!design.modelId) {
      downloadWarnings.push(`Could not get a download for "${entry.filename}".`);
      continue;
    }
    const result = await fetchProfileDownload(
      entry.profileId,
      design.modelId,
      cred.token,
      cred.region,
    );
    if (result === "unauthorized") throw new ImportError(BAMBU_EXPIRED_WARNING);
    if (!result) {
      downloadWarnings.push(`Could not get a download for "${entry.filename}".`);
      continue;
    }
    assets.push({
      url: result.url,
      filename: ensure3mf(result.name, entry.filename),
      kind: "model",
      sourceFileId: entry.sourceFileId,
      ...(entry.modifiedAt ? { sourceModifiedAt: entry.modifiedAt } : {}),
    });
  }

  // Any changed/new .scad re-downloads the whole raw-files zip; staging
  // extracts and re-stages every .scad entry, which the upsert step then
  // matches back by id/name.
  const scad = wanted.find((e) => e.group === "scad");
  if (scad && typeof design.id === "number") {
    const result = await fetchRawModelDownload(design.id, "all", cred.token, cred.region);
    if (result === "unauthorized") throw new ImportError(BAMBU_EXPIRED_WARNING);
    if (!result) {
      downloadWarnings.push("Could not download the model's OpenSCAD source files.");
    } else {
      assets.push({
        url: result.url,
        filename: result.name.trim() || "raw-files.zip",
        kind: "model",
        extractScad: true,
        ...(scad.modifiedAt ? { sourceModifiedAt: scad.modifiedAt } : {}),
      });
    }
  }

  for (const entry of wanted) {
    if (entry.group !== "doc") continue;
    assets.push({
      url: entry.url,
      filename: entry.filename,
      kind: "pdf",
      sourceFileId: entry.sourceFileId,
    });
  }

  return { assets, downloadWarnings };
}

// Resolves fresh download links for the Printables files the plan wants.
async function buildPrintablesAssets(
  plan: SyncPlan<PrintablesUpstreamFile>,
  printId: string,
): Promise<{ assets: RemoteAsset[]; downloadWarnings: string[] }> {
  const wanted = [...plan.toImport, ...plan.toReplace.map((r) => r.upstream)];
  const assets: RemoteAsset[] = [];
  const downloadWarnings: string[] = [];

  for (const entry of wanted) {
    const link = await downloadLink(printId, entry.fileId, entry.fileType);
    if (!link) {
      downloadWarnings.push(`Could not get a download link for ${entry.filename}`);
      continue;
    }
    assets.push({
      url: link,
      filename: entry.filename,
      kind: "model",
      sourceFileId: entry.sourceFileId,
      ...(entry.modifiedAt ? { sourceModifiedAt: entry.modifiedAt } : {}),
    });
  }

  return { assets, downloadWarnings };
}
