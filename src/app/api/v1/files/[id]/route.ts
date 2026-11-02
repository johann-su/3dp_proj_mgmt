import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { modelFiles, models } from "@/db/schema";
import { apiError } from "@/lib/api/http";
import { isUuid } from "@/lib/api/params";
import { apiRoute } from "@/lib/api/route";
import { serveModelFile } from "@/lib/serve-file";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Downloads one file of a (non-trashed) model. The scope that hands out the
// bytes — model files can be paid content — so it's files:read, separate from
// the metadata in models:read. Range requests work, like /api/files.
export const GET = apiRoute<{ id: string }>("files:read", async ({ request, params }) => {
  if (!isUuid(params.id)) return apiError(404, "not_found", "File not found");
  const [row] = await db
    .select({ file: modelFiles })
    .from(modelFiles)
    .innerJoin(models, eq(models.id, modelFiles.modelId))
    .where(and(eq(modelFiles.id, params.id), isNull(models.deletedAt)))
    .limit(1);
  if (!row) return apiError(404, "not_found", "File not found");
  return serveModelFile(request, row.file, { cacheControl: "private, no-store" });
});
