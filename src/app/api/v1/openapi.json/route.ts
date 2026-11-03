import { appUrl } from "@/lib/app-url";
import { apiEnabled } from "@/lib/auth";
import { apiError, apiJson } from "@/lib/api/http";
import { buildOpenApiDocument } from "@/lib/api/openapi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The API's description, readable without a key so tooling (Swagger UI, n8n's
// HTTP node, client generators) can fetch it before anyone has one. It holds
// no catalog data — only shapes. 404 while the API is off, like the rest.
export async function GET() {
  if (!apiEnabled) return apiError(404, "not_found", "Not found");
  return apiJson(buildOpenApiDocument(appUrl("/api/v1").toString()), {
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}
