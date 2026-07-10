-- MakerWorld collection URL a collection was bulk-imported from; enables the
-- "Imported from MakerWorld" link and "Sync" on the collection page.
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "source_url" text;
--> statement-breakpoint
-- Backfill collections imported before this column existed from their job.
UPDATE "collections" c SET "source_url" = j."source_url"
FROM "import_jobs" j
WHERE j."collection_id" = c."id" AND c."source_url" IS NULL;
