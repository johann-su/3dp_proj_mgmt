"use server";

import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { modelFiles, models } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { shortFileToken } from "@/lib/file-token";
import { scanRulerBase, scanRulerOpens } from "@/lib/scanruler";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mints the cookie-less file path a ScanRuler link fetches (the download menu
// appends `/<filename>` and wraps it in `?open=`). Done on click, not at page
// render, because the token is the short-lived kind (see shortFileToken): a
// model page left open for an hour must still produce a working link.
// Any signed-in user may read any live model, so the check is session + a
// file of a non-trashed model that ScanRuler can open; null otherwise.
export async function scanRulerFilePath(fileId: string): Promise<string | null> {
  const session = await getSession();
  if (!session || !scanRulerBase() || !UUID_RE.test(fileId)) return null;

  const [file] = await db
    .select({ id: modelFiles.id, filename: modelFiles.filename, kind: modelFiles.kind })
    .from(modelFiles)
    .innerJoin(models, eq(models.id, modelFiles.modelId))
    .where(and(eq(modelFiles.id, fileId), isNull(models.deletedAt)))
    .limit(1);
  if (!file || file.kind !== "model" || !scanRulerOpens(file.filename)) return null;

  return `/api/files/${file.id}/${shortFileToken(file.id)}`;
}
