-- Usage metrics: page view counts on models/collections, download counts per
-- file — incremented via after() from the model/collection pages and the
-- file-serving route (see src/lib/metrics.ts). Not surfaced in the UI yet.
ALTER TABLE "models" ADD COLUMN "view_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "view_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "model_files" ADD COLUMN "download_count" integer DEFAULT 0 NOT NULL;
