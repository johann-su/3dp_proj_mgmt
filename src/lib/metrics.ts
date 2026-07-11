import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { collections, modelFiles, models } from "@/db/schema";

// Fire-and-forget usage counters, meant to be called from `after()` so they
// never add latency to the response. Errors are swallowed — a lost metrics
// increment shouldn't surface as a broken page/download.

export async function incrementModelViewCount(modelId: string): Promise<void> {
  try {
    await db
      .update(models)
      .set({ viewCount: sql`${models.viewCount} + 1` })
      .where(eq(models.id, modelId));
  } catch (err) {
    console.error("incrementModelViewCount failed", err);
  }
}

export async function incrementCollectionViewCount(
  collectionId: string,
): Promise<void> {
  try {
    await db
      .update(collections)
      .set({ viewCount: sql`${collections.viewCount} + 1` })
      .where(eq(collections.id, collectionId));
  } catch (err) {
    console.error("incrementCollectionViewCount failed", err);
  }
}

export async function incrementFileDownloadCount(fileId: string): Promise<void> {
  try {
    await db
      .update(modelFiles)
      .set({ downloadCount: sql`${modelFiles.downloadCount} + 1` })
      .where(eq(modelFiles.id, fileId));
  } catch (err) {
    console.error("incrementFileDownloadCount failed", err);
  }
}
