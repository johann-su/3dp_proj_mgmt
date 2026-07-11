-- Parametric OpenSCAD support: a generated .3mf remembers which .scad file
-- and parameter values produced it. generated_params_hash dedupes repeat
-- generations of the same values (sha256 over the sorted key=value entries).
ALTER TABLE "model_files" ADD COLUMN "generated_from_id" uuid REFERENCES "model_files"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "model_files" ADD COLUMN "generated_params" jsonb;
--> statement-breakpoint
ALTER TABLE "model_files" ADD COLUMN "generated_params_hash" text;
--> statement-breakpoint
CREATE INDEX "model_files_generated_from_idx" ON "model_files" ("generated_from_id");
