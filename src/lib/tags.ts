import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { modelTags, tags } from "@/db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function normalizeTagNames(input: string[]): string[] {
  return [
    ...new Set(input.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0)),
  ].slice(0, 20);
}

// Upserts tags by name and links them to the model. Shared by the model
// server actions and the background collection import.
export async function linkTags(tx: Tx, modelId: string, tagNames: string[]) {
  if (tagNames.length === 0) return;
  const insertedTags = await tx
    .insert(tags)
    .values(tagNames.map((name) => ({ name })))
    .onConflictDoNothing()
    .returning();
  const existing = await tx
    .select()
    .from(tags)
    .where(inArray(tags.name, tagNames));
  const allTags = [...insertedTags, ...existing];
  const uniqueTagIds = [...new Set(allTags.map((t) => t.id))];
  await tx
    .insert(modelTags)
    .values(uniqueTagIds.map((tagId) => ({ modelId, tagId })))
    .onConflictDoNothing();
}
