import { appUrl } from "@/lib/app-url";
import {
  apiError,
  apiJson,
  duplicateConflict,
  invalidRequest,
  mutationError,
} from "@/lib/api/http";
import { createInputFromBody, resolveAttachments } from "@/lib/api/model-input";
import { parseModelListQuery } from "@/lib/api/params";
import { collectionMembershipSql, getModelDetail, listModels } from "@/lib/api/queries";
import { apiRoute, readJson } from "@/lib/api/route";
import { CreateModelBody } from "@/lib/api/schemas";
import { serializeModel, serializeModelSummary } from "@/lib/api/serialize";
import { uploadTokenKey } from "@/lib/api/upload-token";
import { createModelRecord } from "@/lib/model-mutations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const url = (path: string) => appUrl(path).toString();

// The catalog, newest first by default. Filters combine with AND; see the OpenAPI document (GET /api/v1/openapi.json) for the parameters.
export const GET = apiRoute("models:read", async ({ request, principal }) => {
  const query = parseModelListQuery(request.nextUrl.searchParams);
  if ("error" in query) return invalidRequest(query.error);

  let membership;
  if (query.collectionId) {
    membership = await collectionMembershipSql(query.collectionId);
    if (!membership) return apiError(404, "not_found", "Collection not found");
  }

  const { rows, nextCursor } = await listModels({
    ...query,
    ownerId: query.owner === "me" ? principal.user.id : query.owner,
    membership,
  });
  return apiJson({ data: rows.map((row) => serializeModelSummary(row, url)), nextCursor });
});

// Creates a model from files staged with POST /api/v1/uploads. Attributed to the key's owner, versioned and sliced like a model saved in the browser.
export const POST = apiRoute("models:write", async ({ request, principal }) => {
  const body = CreateModelBody.parse(await readJson(request));
  const files = resolveAttachments(body.files, "files", principal.user.id, uploadTokenKey());
  if ("error" in files) return invalidRequest(files.error);

  const outcome = await createModelRecord(principal.user, createInputFromBody(body, files));
  if ("duplicates" in outcome) return duplicateConflict(outcome.duplicates, url);
  if ("error" in outcome) return mutationError(outcome);

  const model = await getModelDetail(outcome.modelId);
  return apiJson(model ? serializeModel(model, url) : { id: outcome.modelId }, {
    status: 201,
    headers: { Location: url(`/api/v1/models/${outcome.modelId}`) },
  });
});
