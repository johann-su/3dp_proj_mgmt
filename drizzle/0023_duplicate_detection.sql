-- Duplicate detection for imported and uploaded models (issue #118).
--
-- model_files.content_hash: lowercase hex SHA-256 of the stored bytes,
-- digested while the file streams to S3 (src/lib/storage.ts). Only set for
-- kind 'model' — images and PDFs are legitimately shared between models — and
-- never for generated OpenSCAD variants, which have generated_params_hash.
-- No backfill: hashing existing objects means downloading the whole bucket,
-- and a null hash simply never matches, so old files just don't participate
-- in upload dedup until they're re-uploaded. The URL half of the feature
-- (source_url) works on existing rows from day one.
ALTER TABLE "model_files" ADD COLUMN "content_hash" text;--> statement-breakpoint
CREATE INDEX "model_files_content_hash_idx" ON "model_files" USING btree ("content_hash");--> statement-breakpoint
-- model_duplicates: one dismissed flag — "model_id looks like a copy of
-- duplicate_of_id, and the user added it anyway". Detection never blocks or
-- merges, so these rows are purely a moderator worklist (Settings →
-- Duplicates); resolving one deletes it. Unique per (pair, signal) so
-- re-saving the same match is idempotent, and both FKs cascade so purging
-- either model takes its flags with it.
CREATE TABLE "model_duplicates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" uuid NOT NULL,
	"duplicate_of_id" uuid NOT NULL,
	"detected_via" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "model_duplicates" ADD CONSTRAINT "model_duplicates_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_duplicates" ADD CONSTRAINT "model_duplicates_duplicate_of_id_models_id_fk" FOREIGN KEY ("duplicate_of_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_duplicates_pair_idx" ON "model_duplicates" USING btree ("model_id","duplicate_of_id","detected_via");
