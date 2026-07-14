-- Model versioning + trash (issue #55).
--
-- models.deleted_at: soft delete — trashed models are filtered out of every
-- listing and purged (rows + S3) 30 days later from the trash page.
--
-- model_versions: append-only history of a model's mutable state (title,
-- description, category, tags, BOM, ordered file list incl. s3 keys), one row
-- per completed create/edit/Onshape-sync/revert. The id is an identity column
-- (not uuid) because rows written in the same transaction share a now()
-- timestamp — insertion order is the version order. Snapshot shape is
-- ModelVersionSnapshot in src/db/schema.ts.
ALTER TABLE "models" ADD COLUMN "deleted_at" timestamp;
--> statement-breakpoint
CREATE TABLE "model_versions" (
  "id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "model_id" uuid NOT NULL,
  "editor_user_id" text,
  "reason" text NOT NULL,
  "snapshot" jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_versions" ADD CONSTRAINT "model_versions_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "model_versions" ADD CONSTRAINT "model_versions_editor_user_id_user_id_fk" FOREIGN KEY ("editor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "model_versions_model_id_idx" ON "model_versions" ("model_id");
