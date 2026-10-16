-- Homepage pins: any signed-in user can pin a model or collection to the
-- shared "Pinned" section at the top of the homepage; everyone sees every pin.
-- One table per target (rather than a polymorphic row) so each keeps a real
-- FK that cascades with the pinned record; the target id is the primary key,
-- so an item is pinned at most once. pinned_by is informational and survives
-- the pinning user's deletion (set null). No backfill — pins start empty.
CREATE TABLE "model_pins" (
	"model_id" uuid PRIMARY KEY NOT NULL,
	"pinned_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collection_pins" (
	"collection_id" uuid PRIMARY KEY NOT NULL,
	"pinned_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_pins" ADD CONSTRAINT "model_pins_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_pins" ADD CONSTRAINT "model_pins_pinned_by_user_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_pins" ADD CONSTRAINT "collection_pins_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_pins" ADD CONSTRAINT "collection_pins_pinned_by_user_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
