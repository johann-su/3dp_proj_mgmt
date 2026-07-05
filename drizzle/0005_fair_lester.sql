ALTER TABLE "model_files" ADD COLUMN "slice_status" text;--> statement-breakpoint
ALTER TABLE "model_files" ADD COLUMN "slice_source" text;--> statement-breakpoint
ALTER TABLE "model_files" ADD COLUMN "print_time_seconds" integer;--> statement-breakpoint
ALTER TABLE "model_files" ADD COLUMN "filament_grams" real;--> statement-breakpoint
ALTER TABLE "model_files" ADD COLUMN "slice_error" text;