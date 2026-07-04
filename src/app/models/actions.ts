"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq, inArray } from "drizzle-orm";
import { DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { db } from "@/db";
import { modelFiles, models, modelTags, tags } from "@/db/schema";
import { getSession } from "@/lib/auth";
import {
  s3,
  S3_BUCKET,
  MODEL_EXTENSIONS,
  IMAGE_EXTENSIONS,
  fileExtension,
} from "@/lib/s3";

export type UploadedFile = {
  key: string;
  filename: string;
  size: number;
  contentType: string;
  kind: "model" | "image";
};

export type CreateModelInput = {
  title: string;
  description: string;
  categoryId: string | null;
  tags: string[];
  files: UploadedFile[];
};

function validateUploads(files: UploadedFile[]): string | null {
  for (const file of files) {
    // Only accept keys minted by our upload route; anything else could point
    // at objects the user doesn't own.
    if (!/^uploads\/[0-9a-f-]{36}\/[a-zA-Z0-9._-]+$/.test(file.key)) {
      return "Invalid file reference";
    }
    const allowed = file.kind === "model" ? MODEL_EXTENSIONS : IMAGE_EXTENSIONS;
    if (!allowed.includes(fileExtension(file.filename))) {
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
    return { error: "At least one model file (.3mf / .step / .stl) is required" };
  }
  const uploadError = validateUploads(uploads);
  if (uploadError) return { error: uploadError };

  const tagNames = [
    ...new Set(
      input.tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0),
    ),
  ].slice(0, 20);

  const modelId = await db.transaction(async (tx) => {
    const [model] = await tx
      .insert(models)
      .values({
        title,
        description: input.description.trim(),
        categoryId: input.categoryId || null,
        userId: session.user.id,
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
      })),
    );

    if (tagNames.length > 0) {
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
        .values(uniqueTagIds.map((tagId) => ({ modelId: model.id, tagId })))
        .onConflictDoNothing();
    }

    return model.id;
  });

  revalidatePath("/");
  redirect(`/models/${modelId}`);
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
