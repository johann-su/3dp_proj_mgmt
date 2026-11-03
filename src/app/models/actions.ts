"use server";

// The browser's entry points for model mutations: each checks the session and
// hands the work to src/lib/model-mutations.ts, which the public API shares —
// validation and the versioning rules live there, not here.

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import type { DuplicateMatch } from "@/lib/duplicates";
import {
  createModelRecord,
  purgeTrashedModel,
  restoreTrashedModel,
  revertModelToVersion,
  setModelLike,
  trashModel,
  updateModelRecord,
  type CreateModelInput,
  type UpdateModelInput,
} from "@/lib/model-mutations";

export type {
  CreateModelInput,
  FileOrderRef,
  UpdateModelInput,
  UploadedFile,
} from "@/lib/model-mutations";

// A save that didn't happen. `error` is a validation failure to show as a
// toast; `duplicates` is the flag-only duplicate prompt (issue #118) — the
// catalog already holds these models, and re-submitting with
// `confirmDuplicate` saves anyway. On success both actions redirect and
// return nothing.
export type ModelSaveResult =
  | { error: string }
  | { duplicates: DuplicateMatch[] };

const signedOut = { error: "You must be signed in" };

export async function createModel(
  input: CreateModelInput,
): Promise<ModelSaveResult | never> {
  const session = await getSession();
  if (!session) return signedOut;

  const result = await createModelRecord(session.user, input);
  if (!("modelId" in result)) return result;
  redirect(`/models/${result.modelId}`);
}

export async function updateModel(
  input: UpdateModelInput,
): Promise<ModelSaveResult | never> {
  const session = await getSession();
  if (!session) return signedOut;

  const result = await updateModelRecord(session.user, input);
  if (!("modelId" in result)) return result;
  redirect(`/models/${result.modelId}`);
}

// Soft delete into the owner's trash — see trashModel.
export async function deleteModel(
  modelId: string,
): Promise<{ error: string } | never> {
  const session = await getSession();
  if (!session) return signedOut;

  const result = await trashModel(session.user, modelId);
  if ("error" in result) return result;
  redirect("/");
}

export async function restoreModel(
  modelId: string,
): Promise<{ error: string } | Record<string, never>> {
  const session = await getSession();
  if (!session) return signedOut;

  const result = await restoreTrashedModel(session.user, modelId);
  return "error" in result ? result : {};
}

export async function deleteModelPermanently(
  modelId: string,
): Promise<{ error: string } | Record<string, never>> {
  const session = await getSession();
  if (!session) return signedOut;

  const result = await purgeTrashedModel(session.user, modelId);
  return "error" in result ? result : {};
}

export async function revertModelVersion(
  modelId: string,
  versionId: number,
): Promise<{ error: string } | Record<string, never>> {
  const session = await getSession();
  if (!session) return signedOut;

  const result = await revertModelToVersion(session.user, modelId, versionId);
  return "error" in result ? result : {};
}

export async function toggleModelLike(input: {
  modelId: string;
  liked: boolean;
}): Promise<{ error?: string }> {
  const session = await getSession();
  if (!session) return signedOut;

  const result = await setModelLike(session.user, input.modelId, input.liked);
  return "error" in result ? result : {};
}
