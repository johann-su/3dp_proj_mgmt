-- Single-model background imports (the import page's "Import in background" button) reuse import_jobs. "kind" tells the runner and the header indicator which shape of job a row is; "model_id" is the model a finished single-model job created, for the indicator's "View model" link.
ALTER TABLE "import_jobs" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'collection' NOT NULL;
--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN IF NOT EXISTS "model_id" uuid;
--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE set null ON UPDATE no action;
