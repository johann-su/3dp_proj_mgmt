-- Per-file import provenance: model_files.imported marks files whose bytes
-- came from the model's source platform (MakerWorld/Printables URL import,
-- Onshape export, collection import) rather than a manual upload. Shown as a
-- badge in the UI; Onshape sync keeps using onshape_element_id to pick the
-- files it replaces.
--
-- Backfill: Onshape exports are identified exactly by onshape_element_id.
-- For the other platforms, files inserted in the same transaction as their
-- model share its created_at (both default to the transaction-scoped now()),
-- and imported models get all their staged files in that one insert — so a
-- matching timestamp on a model with a source_url means "staged by the
-- importer". Files added by later edits carry a later timestamp and stay
-- false; generated OpenSCAD variants are excluded outright.
ALTER TABLE "model_files" ADD COLUMN "imported" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "model_files" SET "imported" = true WHERE "onshape_element_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "model_files" SET "imported" = true
  FROM "models"
  WHERE "model_files"."model_id" = "models"."id"
    AND "models"."source_url" IS NOT NULL
    AND "model_files"."created_at" = "models"."created_at"
    AND "model_files"."generated_from_id" IS NULL;
