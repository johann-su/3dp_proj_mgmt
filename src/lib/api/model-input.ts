// Turns validated API bodies into the mutation core's inputs (src/lib/model-mutations.ts). Pure, so the merge rules are unit-tested.
//
// The core's update takes the model's *whole* editable state (tags, BOM and videos are full lists, not deltas — that is what the edit form sends). A PATCH names only what changes, so everything it leaves out is filled in from the model as it is now; that merge is the one thing worth getting wrong here, and the reason this module exists.

import type { BomItemInput } from "@/lib/bom";
import { contentTypeForFilename } from "@/lib/file-kind";
import type { CreateModelInput, UpdateModelInput, UploadedFile } from "@/lib/model-mutations";
import type { ModelVideo } from "@/lib/video";
import type { CreateModelBodyIn, UpdateModelBodyIn } from "./schemas";
import { verifyUploadToken, type StagedUpload } from "./upload-token";

export type ResolvedAttachment = { upload: StagedUpload; slice: boolean };

// The staged uploads a body's attachments name, verified for this user. The first bad handle fails the whole request, naming the field it came from — a model saved with some of its files silently missing would be worse.
export function resolveAttachments(
  attachments: { upload: string; slice?: boolean }[] | undefined,
  field: string,
  userId: string,
  key: Buffer,
  nowMs = Date.now(),
): ResolvedAttachment[] | { error: string } {
  const resolved: ResolvedAttachment[] = [];
  for (const [i, attachment] of (attachments ?? []).entries()) {
    const upload = verifyUploadToken(attachment.upload, userId, key, nowMs);
    if (!upload) {
      return {
        error: `${field}.${i}.upload is not a valid upload handle (expired, or from another account?) — upload the file again`,
      };
    }
    resolved.push({ upload, slice: attachment.slice !== false });
  }
  return resolved;
}

export type CurrentModelState = {
  id: string;
  title: string;
  description: string;
  categoryId: string | null;
  tags: string[];
  bom: BomItemInput[];
  videos: ModelVideo[];
};

function uploadedFile({ upload }: ResolvedAttachment): UploadedFile {
  return {
    key: upload.key,
    filename: upload.filename,
    size: upload.size,
    // The core derives the served type from the extension again; this only fills the field.
    contentType: contentTypeForFilename(upload.filename),
    kind: upload.kind,
    ...(upload.contentHash ? { contentHash: upload.contentHash } : {}),
  };
}

// "slice: false" opts a .3mf out of print estimates; the core takes that as the S3 keys to skip.
function skipSliceKeys(files: ResolvedAttachment[]): string[] {
  return files.filter((f) => !f.slice).map((f) => f.upload.key);
}

export function createInputFromBody(
  body: CreateModelBodyIn,
  files: ResolvedAttachment[],
): CreateModelInput {
  return {
    title: body.title,
    description: body.description,
    categoryId: body.categoryId ?? null,
    tags: body.tags,
    bom: body.bom,
    files: files.map(uploadedFile),
    sourceUrl: body.sourceUrl ?? null,
    skipSliceKeys: skipSliceKeys(files),
    confirmDuplicate: body.confirmDuplicate === true,
  };
}

export function updateInputFromPatch(
  current: CurrentModelState,
  patch: UpdateModelBodyIn,
  newFiles: ResolvedAttachment[],
): UpdateModelInput {
  return {
    modelId: current.id,
    title: patch.title ?? current.title,
    description: patch.description ?? current.description,
    // `null` is a real value here (back to "Other"), so only an absent key keeps the current category.
    categoryId: patch.categoryId === undefined ? current.categoryId : patch.categoryId,
    tags: patch.tags ?? current.tags,
    bom: patch.bom ?? current.bom,
    // Not editable through the API yet; passed through so a PATCH can't drop the gallery's linked videos.
    videos: current.videos,
    newFiles: newFiles.map(uploadedFile),
    removedFileIds: patch.removeFileIds ?? [],
    renamedFiles: patch.renameFiles ?? [],
    skipSliceKeys: skipSliceKeys(newFiles),
    confirmDuplicate: patch.confirmDuplicate === true,
  };
}
