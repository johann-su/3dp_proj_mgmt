import { appUrl } from "@/lib/app-url";
import { apiError, apiJson } from "@/lib/api/http";
import { isUuid } from "@/lib/api/params";
import { getCollection } from "@/lib/api/queries";
import { apiRoute } from "@/lib/api/route";
import { serializeCollection } from "@/lib/api/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const url = (path: string) => appUrl(path).toString();

export const GET = apiRoute<{ id: string }>("collections:read", async ({ params }) => {
  const collection = isUuid(params.id) ? await getCollection(params.id) : null;
  return collection
    ? apiJson(serializeCollection(collection, url))
    : apiError(404, "not_found", "Collection not found");
});
