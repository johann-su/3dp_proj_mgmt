CREATE TABLE "bambu_credentials" (
	"user_id" text PRIMARY KEY NOT NULL,
	"account" text NOT NULL,
	"region" text DEFAULT 'global' NOT NULL,
	"token_cipher" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "bambu_credentials" ADD CONSTRAINT "bambu_credentials_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;