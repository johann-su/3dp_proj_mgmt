// One-off backfill of model_files.creator_app/creator_version for .3mf files
// uploaded before the columns existed (new uploads and re-slices fill them in
// src/lib/slicer.ts). Reads only each archive's metadata via ranged storage
// reads; safe to re-run — it only touches rows still missing a creator.
//
//   npm run db:backfill-creator

import { and, eq, ilike, isNull } from "drizzle-orm";
import { db } from "@/db";
import { modelFiles } from "@/db/schema";
import { creatorFallback } from "@/lib/file-creator";
import { get3mfCreator } from "@/lib/threemf-remote";

async function backfill() {
  const rows = await db.query.modelFiles.findMany({
    where: and(
      eq(modelFiles.kind, "model"),
      ilike(modelFiles.filename, "%.3mf"),
      isNull(modelFiles.creatorApp),
    ),
  });
  const counts = new Map<string, number>();
  for (const file of rows) {
    const creator =
      (await get3mfCreator(file.s3Key, file.size)) ?? creatorFallback(file);
    const label = creator?.app ?? "unknown";
    counts.set(label, (counts.get(label) ?? 0) + 1);
    if (!creator) continue;
    await db
      .update(modelFiles)
      .set({ creatorApp: creator.app, creatorVersion: creator.version })
      .where(eq(modelFiles.id, file.id));
  }
  console.log(`Checked ${rows.length} .3mf files:`, Object.fromEntries(counts));
  process.exit(0);
}

backfill().catch((err) => {
  console.error(err);
  process.exit(1);
});
