// Model version history + trash (issue #55) — the DB side. The design in one
// paragraph: model_files always holds exactly the *live* files (no existing
// query has to filter anything out); every completed mutation appends a
// model_versions row with a full JSON snapshot of the mutable state including
// each file's s3Key; removed files lose their row but keep their S3 object as
// long as any snapshot references the key; reverting re-inserts rows from the
// snapshot. S3 objects are only deleted when the last snapshot referencing
// them is pruned (version cap) or the model is purged from the trash.
// The pure snapshot helpers (equality, change summary) live in
// src/lib/version-snapshot.ts.

import { and, asc, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { db } from "@/db";
import {
  bomItems,
  modelFiles,
  models,
  modelTags,
  modelVersions,
  type ModelVersionReason,
  type ModelVersionSnapshot,
} from "@/db/schema";
import { s3, S3_BUCKET } from "@/lib/s3";
import { linkTags, normalizeTagNames } from "@/lib/tags";
import { reportError } from "@/lib/telemetry";
import { buildSnapshot, snapshotsEqual } from "@/lib/version-snapshot";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Versions kept per model. Old versions are pruned oldest-first on every new
// version; S3 objects only referenced by pruned snapshots are deleted with
// them, which is what bounds historical storage per model.
export const VERSION_CAP = 30;

// Days a trashed model stays restorable before the lazy sweep (trash page
// load) purges it for good.
export const TRASH_RETENTION_DAYS = 30;

// The model's current mutable state as a snapshot: fetch the model with its
// relations, then map via the pure buildSnapshot (fixed key order for
// snapshotsEqual, variants excluded, tags sorted — see version-snapshot.ts).
export async function captureSnapshot(
  tx: Tx,
  modelId: string,
): Promise<ModelVersionSnapshot> {
  const model = await tx.query.models.findFirst({
    where: eq(models.id, modelId),
    with: {
      files: { orderBy: (f, { asc: ascOrder }) => ascOrder(f.position) },
      bomItems: { orderBy: (b, { asc: ascOrder }) => ascOrder(b.position) },
      modelTags: { with: { tag: true } },
    },
  });
  if (!model) throw new Error(`Model ${modelId} not found`);
  return buildSnapshot(model);
}

// Models created before versioning shipped have no version rows. Call this at
// the start of a mutation's transaction (before changing anything) so their
// pre-edit state becomes version 1 and stays revertable — the lazy backfill
// that saves a data migration.
export async function ensureBaselineVersion(
  tx: Tx,
  modelId: string,
  ownerUserId: string,
): Promise<void> {
  const existing = await tx
    .select({ id: modelVersions.id })
    .from(modelVersions)
    .where(eq(modelVersions.modelId, modelId))
    .limit(1);
  if (existing.length > 0) return;
  await tx.insert(modelVersions).values({
    modelId,
    editorUserId: ownerUserId,
    reason: "create",
    snapshot: await captureSnapshot(tx, modelId),
  });
}

// Appends a version capturing the model's state *as it now stands in tx* —
// call after all mutations, inside the same transaction. No-op edits (state
// equals the latest snapshot) write nothing. Prunes past VERSION_CAP and
// returns the S3 keys that no remaining snapshot or live file references —
// delete those with deleteS3Keys *after* the transaction commits.
export async function recordVersion(
  tx: Tx,
  modelId: string,
  editorUserId: string,
  reason: ModelVersionReason,
): Promise<string[]> {
  const snapshot = await captureSnapshot(tx, modelId);
  const versions = await tx
    .select({ id: modelVersions.id, snapshot: modelVersions.snapshot })
    .from(modelVersions)
    .where(eq(modelVersions.modelId, modelId))
    .orderBy(asc(modelVersions.id));

  const latest = versions[versions.length - 1];
  if (latest && snapshotsEqual(latest.snapshot, snapshot)) return [];

  await tx
    .insert(modelVersions)
    .values({ modelId, editorUserId, reason, snapshot });

  const excess = versions.length + 1 - VERSION_CAP;
  if (excess <= 0) return [];

  const dropped = versions.slice(0, excess);
  await tx.delete(modelVersions).where(
    inArray(
      modelVersions.id,
      dropped.map((v) => v.id),
    ),
  );

  const referenced = new Set(
    [...versions.slice(excess).map((v) => v.snapshot), snapshot].flatMap((s) =>
      s.files.map((f) => f.s3Key),
    ),
  );
  // Live rows can reference keys no snapshot has — generated variants.
  const live = await tx
    .select({ s3Key: modelFiles.s3Key })
    .from(modelFiles)
    .where(eq(modelFiles.modelId, modelId));
  for (const f of live) referenced.add(f.s3Key);

  return [
    ...new Set(
      dropped
        .flatMap((v) => v.snapshot.files.map((f) => f.s3Key))
        .filter((key) => !referenced.has(key)),
    ),
  ];
}

// Makes the model's live state match a snapshot (fields, tags, BOM, files).
// Files are matched by s3Key: rows whose key the snapshot keeps are updated
// in place (preserving id and download count), missing ones are re-inserted
// from the snapshot, extra ones are deleted — their bytes stay in S3 because
// the version that added them still references the key. Generated variants
// whose .scad source gets deleted cascade away; their S3 keys are returned
// for post-commit deletion (variants are never referenced by snapshots).
// Callers still need to recordVersion afterwards and re-run the slicer.
export async function restoreSnapshot(
  tx: Tx,
  modelId: string,
  snapshot: ModelVersionSnapshot,
  fallbackCategoryId: string | null,
): Promise<string[]> {
  await tx
    .update(models)
    .set({
      title: snapshot.title,
      description: snapshot.description,
      categoryId: snapshot.categoryId ?? fallbackCategoryId,
      // Snapshots written before gallery videos existed lack the key.
      videos: snapshot.videos ?? [],
      updatedAt: new Date(),
    })
    .where(eq(models.id, modelId));

  const live = await tx
    .select()
    .from(modelFiles)
    .where(eq(modelFiles.modelId, modelId));
  const liveMain = live.filter((f) => f.generatedFromId === null);
  const liveByKey = new Map(liveMain.map((f) => [f.s3Key, f]));
  const keptKeys = new Set(snapshot.files.map((f) => f.s3Key));

  const toDelete = liveMain.filter((f) => !keptKeys.has(f.s3Key));
  const deletedIds = new Set(toDelete.map((f) => f.id));
  const variantKeys = live
    .filter((f) => f.generatedFromId !== null && deletedIds.has(f.generatedFromId))
    .map((f) => f.s3Key);
  if (toDelete.length > 0) {
    await tx.delete(modelFiles).where(
      inArray(
        modelFiles.id,
        toDelete.map((f) => f.id),
      ),
    );
  }

  for (const [position, file] of snapshot.files.entries()) {
    const existing = liveByKey.get(file.s3Key);
    if (existing) {
      await tx
        .update(modelFiles)
        .set({ filename: file.filename, position })
        .where(eq(modelFiles.id, existing.id));
    } else {
      await tx.insert(modelFiles).values({
        modelId,
        kind: file.kind,
        filename: file.filename,
        s3Key: file.s3Key,
        size: file.size,
        contentType: file.contentType,
        animated: file.animated,
        position,
        onshapeElementId: file.onshapeElementId,
        // Snapshots written before these fields existed lack them.
        imported: file.imported ?? false,
        sourceFileId: file.sourceFileId ?? null,
        sourceModifiedAt: file.sourceModifiedAt ?? null,
        contentHash: file.contentHash ?? null,
        sliceStatus: file.sliceStatus,
        sliceSource: file.sliceSource,
        printTimeSeconds: file.printTimeSeconds,
        filamentGrams: file.filamentGrams,
        sliceError: file.sliceError,
        printerInfo: file.printerInfo,
      });
    }
  }

  await tx.delete(bomItems).where(eq(bomItems.modelId, modelId));
  if (snapshot.bom.length > 0) {
    await tx.insert(bomItems).values(
      snapshot.bom.map((item, i) => ({ modelId, ...item, position: i })),
    );
  }

  await tx.delete(modelTags).where(eq(modelTags.modelId, modelId));
  await linkTags(tx, modelId, normalizeTagNames(snapshot.tags));

  return variantKeys;
}

// Permanently deletes a model: every S3 object any live file or any version
// snapshot references, then the row (files, versions, tags and collection
// links cascade). S3 first, like the pre-trash hard delete — a failed S3 call
// leaves the model purgeable again instead of leaking objects silently.
export async function purgeModel(modelId: string): Promise<void> {
  const [files, versions] = await Promise.all([
    db
      .select({ s3Key: modelFiles.s3Key })
      .from(modelFiles)
      .where(eq(modelFiles.modelId, modelId)),
    db
      .select({ snapshot: modelVersions.snapshot })
      .from(modelVersions)
      .where(eq(modelVersions.modelId, modelId)),
  ]);
  const keys = new Set([
    ...files.map((f) => f.s3Key),
    ...versions.flatMap((v) => v.snapshot.files.map((f) => f.s3Key)),
  ]);
  await deleteS3Keys([...keys]);
  await db.delete(models).where(eq(models.id, modelId));
}

// Purges trashed models past the retention window. Called lazily from the
// trash page (same self-healing pattern import_jobs uses) — this project
// deliberately has no scheduler container. Scoped to one user's trash
// normally; moderators/admins open the instance-wide trash, so their page
// load sweeps everyone's (userId undefined).
export async function sweepExpiredTrash(userId?: string): Promise<void> {
  const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const expired = await db
    .select({ id: models.id })
    .from(models)
    .where(
      and(
        ...(userId ? [eq(models.userId, userId)] : []),
        isNotNull(models.deletedAt),
        lt(models.deletedAt, cutoff),
      ),
    );
  for (const model of expired) {
    try {
      await purgeModel(model.id);
    } catch (err) {
      // Never break the trash page over a purge hiccup (e.g. S3 down) — the
      // model stays listed and the next load retries.
      reportError(`Failed to purge trashed model ${model.id}`, err);
    }
  }
}

export async function deleteS3Keys(keys: string[]): Promise<void> {
  // DeleteObjects takes at most 1000 keys per call.
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: S3_BUCKET,
        Delete: { Objects: chunk.map((Key) => ({ Key })) },
      }),
    );
  }
}
