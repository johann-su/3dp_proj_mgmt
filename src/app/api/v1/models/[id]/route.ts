import { appUrl } from "@/lib/app-url";
import {
  apiError,
  apiJson,
  duplicateConflict,
  invalidRequest,
  mutationError,
  noContent,
} from "@/lib/api/http";
import { resolveAttachments, updateInputFromPatch } from "@/lib/api/model-input";
import { isUuid } from "@/lib/api/params";
import { getModelDetail } from "@/lib/api/queries";
import { apiRoute, readJson } from "@/lib/api/route";
import { UpdateModelBody } from "@/lib/api/schemas";
import { serializeModel } from "@/lib/api/serialize";
import { uploadTokenKey } from "@/lib/api/upload-token";
import { trashModel, updateModelRecord } from "@/lib/model-mutations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { id: string };

const url = (path: string) => appUrl(path).toString();
const notFound = () => apiError(404, "not_found", "Model not found");

export const GET = apiRoute<Params>("models:read", async ({ params }) => {
  const model = isUuid(params.id) ? await getModelDetail(params.id) : null;
  return model ? apiJson(serializeModel(model, url)) : notFound();
});

// Partial update: only the fields sent change (tags and BOM, when sent, replace the whole list). Recorded as a new version like a browser edit; removed files stay revertable from the model's history.
export const PATCH = apiRoute<Params>("models:write", async ({ request, params, principal }) => {
  if (!isUuid(params.id)) return notFound();
  const patch = UpdateModelBody.parse(await readJson(request));
  const current = await getModelDetail(params.id);
  if (!current) return notFound();

  const newFiles = resolveAttachments(
    patch.addFiles,
    "addFiles",
    principal.user.id,
    uploadTokenKey(),
  );
  if ("error" in newFiles) return invalidRequest(newFiles.error);

  const input = updateInputFromPatch(
    { ...current, categoryId: current.category?.id ?? null },
    patch,
    newFiles,
  );
  const outcome = await updateModelRecord(principal.user, input);
  if ("duplicates" in outcome) return duplicateConflict(outcome.duplicates, url);
  if ("error" in outcome) return mutationError(outcome);

  const model = await getModelDetail(outcome.modelId);
  return model ? apiJson(serializeModel(model, url)) : notFound();
});

// Moves the model to its owner's trash (restorable in the app for 30 days). Owner-gated like the browser's delete: the key's owner, or a moderator.
export const DELETE = apiRoute<Params>("models:write", async ({ params, principal }) => {
  if (!isUuid(params.id)) return notFound();
  const result = await trashModel(principal.user, params.id);
  return "error" in result ? mutationError(result) : noContent();
});
