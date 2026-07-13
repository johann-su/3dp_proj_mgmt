-- Track who generated a parametric .3mf variant. Customizing is open to any
-- signed-in user, so a variant may belong to someone other than the model
-- owner: this lets a non-owner delete their own variants while the owner can
-- delete any. Null for non-generated files and pre-existing variants; set null
-- on user deletion so their variants survive on the owner's model.
ALTER TABLE "model_files" ADD COLUMN "generated_by" text;--> statement-breakpoint
ALTER TABLE "model_files" ADD CONSTRAINT "model_files_generated_by_user_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
