"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  bomItems,
  modelFiles,
  modelLikes,
  models,
  modelTags,
  modelVersions,
  type FileKind,
} from "@/db/schema";
import { getSession } from "@/lib/auth";
import { canActAsOwner } from "@/lib/roles";
import { otherCategoryId } from "@/lib/categories";
import { linkTags, normalizeTagNames } from "@/lib/tags";
import { sanitizeBomItems, type BomItemInput } from "@/lib/bom";
import {
  deleteS3Keys,
  ensureBaselineVersion,
  purgeModel,
  recordVersion,
  restoreSnapshot,
} from "@/lib/model-versions";
import {
  allowedExtensions,
  contentTypeForFilename,
  fileExtension,
  sanitizeRename,
} from "@/lib/s3";
import { processPendingSlices, sliceEligible } from "@/lib/slicer";
import { animatedImageKeys } from "@/lib/storage";
import { isContentHash, type DuplicateVia } from "@/lib/duplicate-key";
import {
  existingModelIds,
  findDuplicatesByContentHash,
  recordDuplicateMatches,
  type DuplicateMatch,
} from "@/lib/duplicates";

export type UploadedFile = {
  key: string;
  filename: string;
  size: number;
  contentType: string;
  kind: FileKind;
  // Set on files exported by the Onshape importer; lets sync replace them.
  onshapeElementId?: string;
  // Set on files staged by the URL importer (the create form passes draft
  // files through unchanged). Only honored when the model actually has a
  // sourceUrl to attribute the provenance to.
  imported?: boolean;
  // Upstream identity + last-modified token stamped by the MakerWorld/
  // Printables importers (see src/lib/import/sync-diff.ts); lets the source
  // sync match this file against the platform's current file list. Honored
  // under the same sourceUrl gate as `imported`.
  sourceFileId?: string;
  sourceModifiedAt?: string;
  // SHA-256 of the uploaded/staged bytes, produced server-side by
  // stageStream/stageBuffer and echoed back through the client. Only stored
  // for kind "model", where it powers upload duplicate detection; re-validated
  // as hex, since it travels through the client like every other field here.
  contentHash?: string;
};

// A save that didn't happen. `error` is a validation failure to show as a
// toast; `duplicates` is the flag-only duplicate prompt (issue #118) — the
// catalog already holds these models, and re-submitting with
// `confirmDuplicate` saves anyway. On success both actions redirect and
// return nothing.
export type ModelSaveResult =
  | { error: string }
  | { duplicates: DuplicateMatch[] };

export type CreateModelInput = {
  title: string;
  description: string;
  categoryId: string | null;
  tags: string[];
  files: UploadedFile[];
  bom?: BomItemInput[];
  sourceUrl?: string | null;
  // Workspace microversion at import time (Onshape imports only).
  onshapeMicroversion?: string | null;
  // S3 keys within `files` that should NOT be queued for slicing — every new
  // .3mf is queued unless the uploader turns it off in the wizard.
  skipSliceKeys?: string[];
  // Set once the user has answered the duplicate prompt with "save anyway";
  // the matches are then recorded instead of blocking the save.
  confirmDuplicate?: boolean;
  // Models the URL importer already flagged this import against (carried in
  // the import draft). Recorded alongside any file-hash matches.
  duplicateOfIds?: string[];
};

function validateSourceUrl(raw: string | null | undefined): string | null | undefined {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname;
    if (
      url.protocol === "https:" &&
      (/(^|\.)makerworld\.com$/.test(host) ||
        /(^|\.)printables\.com$/.test(host) ||
        host === "cad.onshape.com")
    ) {
      // Drop tracking params (?from=recommend etc.); keep the hash, which on
      // MakerWorld identifies the print profile.
      url.search = "";
      return url.toString();
    }
  } catch {
    // fall through
  }
  return undefined; // invalid
}

// Reference to one file in the order chosen in the wizard: either a file
// that already exists on the model, or an index into `newFiles`. Used
// per-kind (model files and images each keep their own relative order).
export type FileOrderRef = { existingId: string } | { newIndex: number };

export type UpdateModelInput = {
  modelId: string;
  title: string;
  description: string;
  categoryId: string | null;
  tags: string[];
  newFiles: UploadedFile[];
  removedFileIds: string[];
  // Filenames edited for files that already exist on the model (kept, not
  // removed). Ids outside the kept set are ignored.
  renamedFiles?: { id: string; filename: string }[];
  modelFileOrder?: FileOrderRef[];
  imageOrder?: FileOrderRef[];
  bom?: BomItemInput[];
  // Kept .3mf files to hand back to the slicer: their estimates and printer
  // info are re-read from scratch. Ids outside the kept set are ignored.
  resliceFileIds?: string[];
  // S3 keys within newFiles that should NOT be queued for slicing — the
  // wizard queues every new .3mf unless the uploader turns it off.
  skipSliceKeys?: string[];
  // See CreateModelInput — a new file matching another model's is flagged the
  // same way on edit.
  confirmDuplicate?: boolean;
};

// Merges a client-supplied order (kept-file ids interleaved with indices into
// newFiles) with any files of that kind the client didn't reference, which
// are appended at the end. Kept generic over `kind` so model files and
// images can each keep their own relative order within the shared,
// otherwise-flat `position` column.
function resolveFileOrder(
  kind: FileKind,
  kept: { id: string; kind: FileKind }[],
  newFiles: UploadedFile[],
  insertedIds: string[],
  orderRefs: FileOrderRef[] | undefined,
): string[] {
  const keptIds = new Set(kept.filter((f) => f.kind === kind).map((f) => f.id));
  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (id: string | undefined) => {
    if (id && !seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  };
  for (const ref of orderRefs ?? []) {
    if ("existingId" in ref) {
      if (keptIds.has(ref.existingId)) push(ref.existingId);
    } else if (newFiles[ref.newIndex]?.kind === kind) {
      push(insertedIds[ref.newIndex]);
    }
  }
  for (const id of keptIds) push(id);
  newFiles.forEach((file, i) => {
    if (file.kind === kind) push(insertedIds[i]);
  });
  return ordered;
}

function validateUploads(files: UploadedFile[]): string | null {
  for (const file of files) {
    // Only accept keys minted by our upload route; anything else could point
    // at objects the user doesn't own.
    if (!/^uploads\/[0-9a-f-]{36}\/[a-zA-Z0-9._-]+$/.test(file.key)) {
      return "Invalid file reference";
    }
    if (!allowedExtensions(file.kind).includes(fileExtension(file.filename))) {
      return `File type not allowed: ${file.filename}`;
    }
  }
  return null;
}

// Content hashes of the model files in an upload set. Only kind "model" is
// hashed for dedup (images and PDFs are legitimately shared between models),
// and the value is re-validated because it round-trips through the client.
function modelFileHashes(files: UploadedFile[]): string[] {
  return files.flatMap((f) =>
    f.kind === "model" && isContentHash(f.contentHash) ? [f.contentHash] : [],
  );
}

export async function createModel(
  input: CreateModelInput,
): Promise<ModelSaveResult | never> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };

  const title = input.title.trim();
  if (!title) return { error: "Title is required" };

  const uploads = input.files;
  if (!uploads.some((f) => f.kind === "model")) {
    return { error: "At least one model file (.3mf, .scad or .step) is required" };
  }
  const uploadError = validateUploads(uploads);
  if (uploadError) return { error: uploadError };

  const bomResult = sanitizeBomItems(input.bom ?? []);
  if ("error" in bomResult) return { error: bomResult.error };
  const bom = bomResult.items;

  const sourceUrl = validateSourceUrl(input.sourceUrl);
  if (sourceUrl === undefined) {
    return { error: "Source URL must be a MakerWorld, Printables or Onshape link" };
  }

  // Onshape sync metadata only makes sense on models imported from Onshape.
  const isOnshape = !!sourceUrl && sourceUrl.includes("//cad.onshape.com/");
  const onshapeId = (value: string | null | undefined) =>
    isOnshape && value && /^[0-9a-f]{24}$/.test(value) ? value : null;
  const onshapeMicroversion = onshapeId(input.onshapeMicroversion);

  const tagNames = normalizeTagNames(input.tags);

  // Duplicate detection, raw-upload half: is one of these model files already
  // in the catalog? Flags, never blocks. /api/import covers the sourceUrl half
  // before it stages anything and hands its matches over as duplicateOfIds —
  // filtered here against real, untrashed models, since those ids ride in
  // through the client draft and a bogus one would fail the FK and take the
  // whole save down with it.
  const sourceMatchIds = await existingModelIds(input.duplicateOfIds ?? []);
  const hashMatches = await findDuplicatesByContentHash(modelFileHashes(uploads));

  // A design imported past the URL prompt usually hash-matches that same
  // model's files as well — asking again here would be the same question
  // twice. Only genuinely new matches get a prompt.
  const answered = new Set(sourceMatchIds);
  const unanswered = hashMatches.filter((m) => !answered.has(m.id));
  if (unanswered.length > 0 && !input.confirmDuplicate) {
    return { duplicates: unanswered };
  }

  // Everything this model was flagged against and saved anyway, for the
  // moderator worklist. Source-URL matches first — recordDuplicateMatches
  // keeps one row per pair, and "same upstream design" is the better
  // explanation to keep when both signals fired.
  const dismissedMatches: { duplicateOfId: string; via: DuplicateVia }[] = [
    ...sourceMatchIds.map((id) => ({
      duplicateOfId: id,
      via: "source_url" as const,
    })),
    ...hashMatches.map((d) => ({ duplicateOfId: d.id, via: "file_hash" as const })),
  ];

  // Sniff image headers up front (outside the transaction) so animated covers
  // can be frozen to a poster frame in browse cards.
  const animatedKeys = await animatedImageKeys(uploads);
  const skipSlice = new Set(input.skipSliceKeys ?? []);

  // No model stays uncategorized — the form preselects a suggestion, but a
  // stale/hand-crafted request still lands in "Other".
  const categoryId = input.categoryId || (await otherCategoryId());

  const modelId = await db.transaction(async (tx) => {
    const [model] = await tx
      .insert(models)
      .values({
        title,
        description: input.description.trim(),
        categoryId,
        userId: session.user.id,
        sourceUrl,
        onshapeMicroversion,
      })
      .returning({ id: models.id });

    let position = 0;
    await tx.insert(modelFiles).values(
      uploads.map((file) => {
        const elementId =
          file.kind === "model" ? onshapeId(file.onshapeElementId) : null;
        // Like `imported`, upstream sync ids are only meaningful with a
        // source to sync against; length-capped since they travel through
        // the client draft.
        const sourceString = (value: string | undefined, max: number) =>
          sourceUrl && typeof value === "string" && value.length <= max
            ? value
            : null;
        return {
          modelId: model.id,
          kind: file.kind,
          filename: file.filename,
          s3Key: file.key,
          size: file.size,
          // Never store the client-claimed type; derive from the validated
          // extension (an inline-served text/html "image" would be stored XSS).
          contentType: contentTypeForFilename(file.filename),
          animated: animatedKeys.has(file.key),
          position: position++,
          onshapeElementId: elementId,
          imported: (!!sourceUrl && file.imported === true) || elementId !== null,
          sourceFileId: sourceString(file.sourceFileId, 300),
          sourceModifiedAt: sourceString(file.sourceModifiedAt, 64),
          contentHash:
            file.kind === "model" && isContentHash(file.contentHash)
              ? file.contentHash
              : null,
          sliceStatus:
            sliceEligible(file.kind, file.filename) && !skipSlice.has(file.key)
              ? ("pending" as const)
              : null,
        };
      }),
    );

    if (bom.length > 0) {
      await tx.insert(bomItems).values(
        bom.map((item, i) => ({
          modelId: model.id,
          name: item.name,
          quantity: item.quantity,
          link: item.link,
          imageUrl: item.imageUrl,
          section: item.section,
          position: i,
        })),
      );
    }

    await linkTags(tx, model.id, tagNames);

    await recordDuplicateMatches(tx, model.id, dismissedMatches);

    // Version 1 — the append-only edit history starts at creation (issue #55).
    await recordVersion(tx, model.id, session.user.id, "create");

    return model.id;
  });

  // Estimate print time & filament use once the response is sent.
  after(() => processPendingSlices(modelId));

  revalidatePath("/");
  redirect(`/models/${modelId}`);
}

export async function updateModel(
  input: UpdateModelInput,
): Promise<ModelSaveResult | never> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };

  const title = input.title.trim();
  if (!title) return { error: "Title is required" };

  const uploadError = validateUploads(input.newFiles);
  if (uploadError) return { error: uploadError };

  const bomResult = sanitizeBomItems(input.bom ?? []);
  if ("error" in bomResult) return { error: bomResult.error };
  const bom = bomResult.items;

  const tagNames = normalizeTagNames(input.tags);

  const model = await db.query.models.findFirst({
    where: eq(models.id, input.modelId),
    with: { files: true },
  });
  if (!model || model.deletedAt) return { error: "Model not found" };
  // Editing is open to any signed-in user (collaborative library for a trusted
  // self-hosted group) — only deletion stays owner-only. See deleteModel.

  const removedIds = new Set(input.removedFileIds);
  // Removing a parametric .scad also removes the .3mf variants generated from
  // it. The DB FK cascade would drop the rows anyway, but the ids must be in
  // the removed set so the S3 cleanup below deletes their objects too.
  for (const f of model.files) {
    if (f.generatedFromId !== null && removedIds.has(f.generatedFromId)) {
      removedIds.add(f.id);
    }
  }
  const removed = model.files.filter((f) => removedIds.has(f.id));
  const kept = model.files.filter((f) => !removedIds.has(f.id));
  const keptById = new Map(kept.map((f) => [f.id, f]));
  const renameById = new Map((input.renamedFiles ?? []).map((f) => [f.id, f.filename]));
  const hasModelFile =
    kept.some((f) => f.kind === "model") ||
    input.newFiles.some((f) => f.kind === "model");
  if (!hasModelFile) return { error: "At least one model file (.3mf, .scad or .step) is required" };

  // A file added here may already live on a *different* model — same prompt as
  // createModel, scoped to exclude this one (re-adding a file the model
  // already has is the user's business, not a cross-model duplicate).
  const duplicates = await findDuplicatesByContentHash(
    modelFileHashes(input.newFiles),
    { excludeModelId: model.id },
  );
  if (duplicates.length > 0 && !input.confirmDuplicate) {
    return { duplicates };
  }

  // Sniff new image headers up front (outside the transaction) so animated
  // covers are frozen to a poster frame in browse cards.
  const animatedKeys = await animatedImageKeys(input.newFiles);
  const skipSlice = new Set(input.skipSliceKeys ?? []);

  // Same fallback as createModel: clearing the category means "Other".
  const categoryId = input.categoryId || (await otherCategoryId());

  const s3KeysToDelete = await db.transaction(async (tx) => {
    // Models that predate versioning get their pre-edit state recorded as
    // version 1 first, so this edit stays revertable (issue #55).
    await ensureBaselineVersion(tx, model.id, model.userId);

    await tx
      .update(models)
      .set({
        title,
        description: input.description.trim(),
        categoryId,
        updatedAt: new Date(),
      })
      .where(eq(models.id, model.id));

    if (removed.length > 0) {
      await tx.delete(modelFiles).where(
        inArray(
          modelFiles.id,
          removed.map((f) => f.id),
        ),
      );
    }

    // Insert new files; the temporary position doubles as the index into
    // input.newFiles so returned ids can be mapped back regardless of the
    // order RETURNING yields them in.
    const insertedIds: string[] = [];
    if (input.newFiles.length > 0) {
      const inserted = await tx
        .insert(modelFiles)
        .values(
          input.newFiles.map((file, i) => ({
            modelId: model.id,
            kind: file.kind,
            filename: file.filename,
            s3Key: file.key,
            size: file.size,
            contentType: contentTypeForFilename(file.filename),
            animated: animatedKeys.has(file.key),
            position: i,
            contentHash:
              file.kind === "model" && isContentHash(file.contentHash)
                ? file.contentHash
                : null,
            sliceStatus:
              sliceEligible(file.kind, file.filename) && !skipSlice.has(file.key)
                ? ("pending" as const)
                : null,
          })),
        )
        .returning({ id: modelFiles.id, position: modelFiles.position });
      for (const row of inserted) insertedIds[row.position] = row.id;
    }

    // Recompute positions: model files and images each follow the order
    // chosen in the wizard (resolveFileOrder appends anything the client
    // didn't reference); PDFs just keep kept-then-new, since there's no
    // reorder UI for them.
    const orderedModelIds = resolveFileOrder(
      "model",
      kept,
      input.newFiles,
      insertedIds,
      input.modelFileOrder,
    );
    const orderedImageIds = resolveFileOrder(
      "image",
      kept,
      input.newFiles,
      insertedIds,
      input.imageOrder,
    );
    const orderedIds = [
      ...orderedModelIds,
      ...kept.filter((f) => f.kind === "pdf").map((f) => f.id),
      ...input.newFiles
        .map((file, i) => (file.kind === "pdf" ? insertedIds[i] : null))
        .filter((id): id is string => id !== null),
      ...orderedImageIds,
    ];
    for (const [position, id] of orderedIds.entries()) {
      // Only kept (pre-existing) files can be renamed; newly inserted ones
      // already carry their desired filename from the upload step.
      const keptFile = keptById.get(id);
      const proposedName = keptFile && renameById.get(id);
      const filename = proposedName && sanitizeRename(keptFile.filename, proposedName);
      await tx
        .update(modelFiles)
        .set(filename ? { position, filename } : { position })
        .where(and(eq(modelFiles.id, id), eq(modelFiles.modelId, model.id)));
    }

    await tx.delete(bomItems).where(eq(bomItems.modelId, model.id));
    if (bom.length > 0) {
      await tx.insert(bomItems).values(
        bom.map((item, i) => ({
          modelId: model.id,
          name: item.name,
          quantity: item.quantity,
          link: item.link,
          imageUrl: item.imageUrl,
          section: item.section,
          position: i,
        })),
      );
    }

    await tx.delete(modelTags).where(eq(modelTags.modelId, model.id));
    await linkTags(tx, model.id, tagNames);

    await recordDuplicateMatches(
      tx,
      model.id,
      duplicates.map((d) => ({ duplicateOfId: d.id, via: "file_hash" })),
    );

    // Snapshot the post-edit state. Removed files keep their S3 objects —
    // earlier versions still reference the keys, so they stay revertable.
    // Only generated variants (never referenced by snapshots) lose their
    // bytes when their .scad source is removed, plus whatever version
    // pruning orphaned.
    const pruned = await recordVersion(tx, model.id, session.user.id, "edit");
    const variantKeys = removed
      .filter((f) => f.generatedFromId !== null)
      .map((f) => f.s3Key);
    return [...variantKeys, ...pruned];
  });

  await deleteS3Keys(s3KeysToDelete);

  // Files the editor put back in the slice queue: "pending" is all it takes —
  // the pass below (and any later model-page view) picks them up and rewrites
  // the estimates and printer_info. Deliberately outside the transaction, so
  // re-slicing on its own doesn't record a version: the snapshot covers
  // sliceStatus, and the slicer's own writes land outside versioning too.
  // The old estimates stay visible until the new ones replace them.
  const resliceIds = (input.resliceFileIds ?? []).filter((id) => {
    const file = keptById.get(id);
    return file !== undefined && sliceEligible(file.kind, file.filename);
  });
  if (resliceIds.length > 0) {
    await db
      .update(modelFiles)
      .set({ sliceStatus: "pending", sliceError: null })
      .where(
        and(eq(modelFiles.modelId, model.id), inArray(modelFiles.id, resliceIds)),
      );
  }

  // Estimate print time & filament use once the response is sent.
  after(() => processPendingSlices(model.id));

  revalidatePath("/");
  revalidatePath(`/models/${model.id}`);
  redirect(`/models/${model.id}`);
}

// Moves the model to the trash (soft delete). Nothing is destroyed: the rows,
// version history and S3 objects stay, the model just disappears from every
// listing. The owner can restore it from /models/trash for
// TRASH_RETENTION_DAYS; after that the lazy sweep purges it for real.
export async function deleteModel(
  modelId: string,
): Promise<{ error: string } | never> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };

  const model = await db.query.models.findFirst({
    where: eq(models.id, modelId),
    columns: { userId: true, deletedAt: true },
  });
  if (!model || model.deletedAt) return { error: "Model not found" };
  // Deletion stays owner-gated even though editing is open to everyone —
  // trashing removes the model from the shared library, unlike an edit.
  // Moderators/admins pass as owner-equivalent (issue #54).
  if (!canActAsOwner(session.user, model.userId)) {
    return { error: "Not your model" };
  }

  await db
    .update(models)
    .set({ deletedAt: new Date() })
    .where(eq(models.id, modelId));

  revalidatePath("/");
  revalidatePath(`/models/${modelId}`);
  redirect("/");
}

// Takes a model back out of the trash — deletion is just deleted_at, so
// restoring is clearing it. Gated like the deletion it undoes: the owner, or
// a moderator/admin.
export async function restoreModel(
  modelId: string,
): Promise<{ error: string } | Record<string, never>> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };

  const model = await db.query.models.findFirst({
    where: eq(models.id, modelId),
    columns: { userId: true, deletedAt: true },
  });
  if (!model || !model.deletedAt) return { error: "Model not found in trash" };
  if (!canActAsOwner(session.user, model.userId)) {
    return { error: "Not your model" };
  }

  await db
    .update(models)
    .set({ deletedAt: null })
    .where(eq(models.id, modelId));

  revalidatePath("/");
  revalidatePath(`/models/${modelId}`);
  return {};
}

// The old hard delete, now opt-in from the trash page only: removes the rows,
// the version history and every S3 object any of them reference.
export async function deleteModelPermanently(
  modelId: string,
): Promise<{ error: string } | Record<string, never>> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };

  const model = await db.query.models.findFirst({
    where: eq(models.id, modelId),
    columns: { userId: true, deletedAt: true },
  });
  // Only trashed models can be purged — the trash is the single doorway to
  // destroying data.
  if (!model || !model.deletedAt) return { error: "Model not found in trash" };
  if (!canActAsOwner(session.user, model.userId)) {
    return { error: "Not your model" };
  }

  await purgeModel(modelId);

  revalidatePath("/");
  return {};
}

// Restores the state a version snapshot recorded — fields, tags, BOM and
// files (previously removed files come back; their bytes never left S3).
// Open to any signed-in user like editing itself, and append-only: the revert
// writes a new version instead of rewriting history, so reverting a revert
// always works.
export async function revertModelVersion(
  modelId: string,
  versionId: number,
): Promise<{ error: string } | Record<string, never>> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };

  const model = await db.query.models.findFirst({
    where: eq(models.id, modelId),
    columns: { id: true, deletedAt: true },
  });
  if (!model || model.deletedAt) return { error: "Model not found" };

  const version = await db.query.modelVersions.findFirst({
    where: and(eq(modelVersions.id, versionId), eq(modelVersions.modelId, modelId)),
  });
  if (!version) return { error: "Version not found" };

  // Same fallback as create/update: a null category means "Other".
  const fallbackCategoryId = await otherCategoryId();

  const s3KeysToDelete = await db.transaction(async (tx) => {
    const variantKeys = await restoreSnapshot(
      tx,
      modelId,
      version.snapshot,
      fallbackCategoryId,
    );
    const pruned = await recordVersion(tx, modelId, session.user.id, "revert");
    return [...variantKeys, ...pruned];
  });

  await deleteS3Keys(s3KeysToDelete);

  // Re-inserted files may carry a pending slice status from their snapshot.
  after(() => processPendingSlices(modelId));

  revalidatePath("/");
  revalidatePath(`/models/${modelId}`);
  return {};
}

// Like/unlike a model for the current user. A like is per-user metadata, not a
// model mutation, so it deliberately skips the versioning machinery — no
// snapshot, no S3 bookkeeping. Any signed-in user may like any (non-trashed)
// model; the liked list lives at /models/liked.
export async function toggleModelLike(input: {
  modelId: string;
  liked: boolean;
}): Promise<{ error?: string }> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };

  const model = await db.query.models.findFirst({
    where: eq(models.id, input.modelId),
    columns: { id: true, deletedAt: true },
  });
  if (!model || model.deletedAt) return { error: "Model not found" };

  if (input.liked) {
    await db
      .insert(modelLikes)
      .values({ userId: session.user.id, modelId: input.modelId })
      .onConflictDoNothing();
  } else {
    await db
      .delete(modelLikes)
      .where(
        and(
          eq(modelLikes.userId, session.user.id),
          eq(modelLikes.modelId, input.modelId),
        ),
      );
  }

  revalidatePath(`/models/${input.modelId}`);
  revalidatePath("/models/liked");
  return {};
}
