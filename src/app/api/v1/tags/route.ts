import { apiJson } from "@/lib/api/http";
import { listTags } from "@/lib/api/queries";
import { apiRoute } from "@/lib/api/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Tags in use on at least one model, with how many carry each.
export const GET = apiRoute("models:read", async () => apiJson({ data: await listTags() }));
