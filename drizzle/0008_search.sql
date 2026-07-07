-- Fuzzy search infrastructure. pg_trgm powers typo-tolerant matching over
-- model/collection titles + descriptions; the model_files expression indexes
-- back the printer/filament/nozzle/print-time facets used by /search.
--
-- Note: migrations run inside a transaction (scripts/migrate.mjs), so these
-- are plain CREATE INDEX (not CONCURRENTLY).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "models_title_trgm_idx" ON "models" USING gin ("title" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "models_description_trgm_idx" ON "models" USING gin ("description" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collections_title_trgm_idx" ON "collections" USING gin ("title" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collections_description_trgm_idx" ON "collections" USING gin ("description" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_files_printer_model_idx" ON "model_files" (("printer_info" ->> 'model'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_files_nozzle_idx" ON "model_files" (("printer_info" ->> 'nozzleDiameterMm'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_files_filament_idx" ON "model_files" USING gin (("printer_info" -> 'filamentTypes'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_files_print_time_idx" ON "model_files" ("print_time_seconds");
