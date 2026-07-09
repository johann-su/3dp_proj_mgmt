"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { db } from "@/db";
import {
  bomItems,
  modelFiles,
  models,
  modelTags,
  tags,
  type FileKind,
} from "@/db/schema";
import { getSession } from "@/lib/auth";
import { sanitizeBomItems, type BomItemInput } from "@/lib/bom";
import { s3, S3_BUCKET, allowedExtensions, fileExtension, sanitizeRename } from "@/lib/s3";
import { processPendingSlices, sliceEligible } from "@/lib/slicer";

export type UploadedFile = {
  key: string;
  filename: string;
  size: number;
  contentType: string;
  kind: FileKind;
  // Set on files exported by the Onshape importer; lets sync replace them.
  onshapeElementId?: string;
};

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

// Reference to one image in the order chosen in the wizard: either a file
// that already exists on the model, or an index into `newFiles`.
export type ImageOrderRef = { existingId: string } | { newIndex: number };

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
  imageOrder?: ImageOrderRef[];
  bom?: BomItemInput[];
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function normalizeTagNames(input: string[]): string[] {
  return [
    ...new Set(input.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0)),
  ].slice(0, 20);
}

async function linkTags(tx: Tx, modelId: string, tagNames: string[]) {
  if (tagNames.length === 0) return;
  const insertedTags = await tx
    .insert(tags)
    .values(tagNames.map((name) => ({ name })))
    .onConflictDoNothing()
    .returning();
  const existing = await tx
    .select()
    .from(tags)
    .where(inArray(tags.name, tagNames));
  const allTags = [...insertedTags, ...existing];
  const uniqueTagIds = [...new Set(allTags.map((t) => t.id))];
  await tx
    .insert(modelTags)
    .values(uniqueTagIds.map((tagId) => ({ modelId, tagId })))
    .onConflictDoNothing();
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

export async function createModel(
  input: CreateModelInput,
): Promise<{ error: string } | never> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };

  const title = input.title.trim();
  if (!title) return { error: "Title is required" };

  const uploads = input.files;
  if (!uploads.some((f) => f.kind === "model")) {
    return { error: "At least one model file (.3mf or .step) is required" };
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

  const modelId = await db.transaction(async (tx) => {
    const [model] = await tx
      .insert(models)
      .values({
        title,
        description: input.description.trim(),
        categoryId: input.categoryId || null,
        userId: session.user.id,
        sourceUrl,
        onshapeMicroversion,
      })
      .returning({ id: models.id });

    let position = 0;
    await tx.insert(modelFiles).values(
      uploads.map((file) => ({
        modelId: model.id,
        kind: file.kind,
        filename: file.filename,
        s3Key: file.key,
        size: file.size,
        contentType: file.contentType,
        position: position++,
        onshapeElementId:
          file.kind === "model" ? onshapeId(file.onshapeElementId) : null,
        sliceStatus: sliceEligible(file.kind, file.filename)
          ? ("pending" as const)
          : null,
      })),
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

    return model.id;
  });

  // Estimate print time & filament use once the response is sent.
  after(() => processPendingSlices(modelId));

  revalidatePath("/");
  redirect(`/models/${modelId}`);
}

export async function updateModel(
  input: UpdateModelInput,
): Promise<{ error: string } | never> {
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
  if (!model) return { error: "Model not found" };
  if (model.userId !== session.user.id) return { error: "Not your model" };

  const removedIds = new Set(input.removedFileIds);
  const removed = model.files.filter((f) => removedIds.has(f.id));
  const kept = model.files.filter((f) => !removedIds.has(f.id));
  const keptById = new Map(kept.map((f) => [f.id, f]));
  const renameById = new Map((input.renamedFiles ?? []).map((f) => [f.id, f.filename]));
  const hasModelFile =
    kept.some((f) => f.kind === "model") ||
    input.newFiles.some((f) => f.kind === "model");
  if (!hasModelFile) return { error: "At least one model file (.3mf or .step) is required" };

  await db.transaction(async (tx) => {
    await tx
      .update(models)
      .set({
        title,
        description: input.description.trim(),
        categoryId: input.categoryId || null,
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
            contentType: file.contentType,
            position: i,
            sliceStatus: sliceEligible(file.kind, file.filename)
              ? ("pending" as const)
              : null,
          })),
        )
        .returning({ id: modelFiles.id, position: modelFiles.position });
      for (const row of inserted) insertedIds[row.position] = row.id;
    }

    // Recompute positions: print files keep their order (kept, then new);
    // images follow the order chosen in the wizard, with any image the
    // client didn't reference appended at the end.
    const keptImageIds = new Set(
      kept.filter((f) => f.kind === "image").map((f) => f.id),
    );
    const orderedImageIds: string[] = [];
    const seen = new Set<string>();
    const pushImage = (id: string | undefined) => {
      if (id && !seen.has(id)) {
        seen.add(id);
        orderedImageIds.push(id);
      }
    };
    for (const ref of input.imageOrder ?? []) {
      if ("existingId" in ref) {
        if (keptImageIds.has(ref.existingId)) pushImage(ref.existingId);
      } else if (input.newFiles[ref.newIndex]?.kind === "image") {
        pushImage(insertedIds[ref.newIndex]);
      }
    }
    for (const id of keptImageIds) pushImage(id);
    input.newFiles.forEach((file, i) => {
      if (file.kind === "image") pushImage(insertedIds[i]);
    });

    const orderedIds = [
      ...kept.filter((f) => f.kind === "model").map((f) => f.id),
      ...input.newFiles
        .map((file, i) => (file.kind === "model" ? insertedIds[i] : null))
        .filter((id): id is string => id !== null),
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
  });

  if (removed.length > 0) {
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: S3_BUCKET,
        Delete: { Objects: removed.map((f) => ({ Key: f.s3Key })) },
      }),
    );
  }

  // Estimate print time & filament use once the response is sent.
  after(() => processPendingSlices(model.id));

  revalidatePath("/");
  revalidatePath(`/models/${model.id}`);
  redirect(`/models/${model.id}`);
}

export async function deleteModel(
  modelId: string,
): Promise<{ error: string } | never> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };

  const model = await db.query.models.findFirst({
    where: eq(models.id, modelId),
    with: { files: true },
  });
  if (!model) return { error: "Model not found" };
  if (model.userId !== session.user.id) return { error: "Not your model" };

  if (model.files.length > 0) {
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: S3_BUCKET,
        Delete: { Objects: model.files.map((f) => ({ Key: f.s3Key })) },
      }),
    );
  }
  await db.delete(models).where(eq(models.id, modelId));

  revalidatePath("/");
  redirect("/");
}
