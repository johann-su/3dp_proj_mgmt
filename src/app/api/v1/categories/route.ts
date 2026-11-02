import { apiJson } from "@/lib/api/http";
import { listCategories } from "@/lib/api/queries";
import { apiRoute } from "@/lib/api/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Every category, by name — the ids POST/PATCH /models take as categoryId.
export const GET = apiRoute("models:read", async () =>
  apiJson({ data: await listCategories() }),
);
