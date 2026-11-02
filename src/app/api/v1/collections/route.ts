import { appUrl } from "@/lib/app-url";
import { apiJson, invalidRequest } from "@/lib/api/http";
import { decodeCursor, parseLimit } from "@/lib/api/params";
import { listCollections } from "@/lib/api/queries";
import { apiRoute } from "@/lib/api/route";
import { serializeCollection } from "@/lib/api/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const url = (path: string) => appUrl(path).toString();

// Every collection, newest first. Members are listed through
// GET /models?collection=<id>, with all of that endpoint's filters.
export const GET = apiRoute("collections:read", async ({ request }) => {
  const sp = request.nextUrl.searchParams;
  const limit = parseLimit(sp.get("limit"));
  if (typeof limit !== "number") return invalidRequest(limit.error);
  const rawCursor = sp.get("cursor");
  const cursor = rawCursor ? decodeCursor(rawCursor, "created_desc") : null;
  if (rawCursor && !cursor) return invalidRequest("cursor is invalid");

  const { rows, nextCursor } = await listCollections({ limit, cursor });
  return apiJson({ data: rows.map((row) => serializeCollection(row, url)), nextCursor });
});
