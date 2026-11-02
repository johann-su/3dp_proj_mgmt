import { apiError, mutationError, noContent } from "@/lib/api/http";
import { isUuid } from "@/lib/api/params";
import { apiRoute } from "@/lib/api/route";
import { setCollectionMembership } from "@/lib/collection-mutations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { id: string; modelId: string };

// Adds a model to (PUT) or removes it from (DELETE) a hand-picked collection.
// Both are idempotent; smart collections answer 400, since their rules decide
// membership.
function membership(member: boolean) {
  return apiRoute<Params>("collections:write", async ({ params, principal }) => {
    if (!isUuid(params.id) || !isUuid(params.modelId)) {
      return apiError(404, "not_found", "Not found");
    }
    const result = await setCollectionMembership(principal.user, {
      collectionId: params.id,
      modelId: params.modelId,
      member,
    });
    return "error" in result ? mutationError(result) : noContent();
  });
}

export const PUT = membership(true);
export const DELETE = membership(false);
