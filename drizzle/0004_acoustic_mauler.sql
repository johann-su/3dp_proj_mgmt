CREATE TABLE "onshape_credentials" (
	"user_id" text PRIMARY KEY NOT NULL,
	"account" text NOT NULL,
	"access_key" text NOT NULL,
	"secret_key_cipher" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_files" ADD COLUMN "onshape_element_id" text;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "onshape_microversion" text;--> statement-breakpoint
ALTER TABLE "onshape_credentials" ADD CONSTRAINT "onshape_credentials_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;