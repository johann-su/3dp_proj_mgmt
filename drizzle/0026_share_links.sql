-- Public share links: a model or collection can be opened by anyone holding
-- its link, without signing in. Private stays the default — a row exists only
-- while a link is live. One table per target (like the pins) so each keeps a
-- real FK that cascades; the target id is the primary key, so there is at most
-- one live link per item. Revoking deletes the row and re-enabling mints a new
-- random token, so a revoked URL never resolves again. The token is a 256-bit
-- random bearer secret, stored as-is so the share dialog can show the link
-- again; created_by is informational and survives the user's deletion.
CREATE TABLE "model_share_links" (
	"model_id" uuid PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "model_share_links_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "collection_share_links" (
	"collection_id" uuid PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "collection_share_links_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "model_share_links" ADD CONSTRAINT "model_share_links_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_share_links" ADD CONSTRAINT "model_share_links_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_share_links" ADD CONSTRAINT "collection_share_links_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_share_links" ADD CONSTRAINT "collection_share_links_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
