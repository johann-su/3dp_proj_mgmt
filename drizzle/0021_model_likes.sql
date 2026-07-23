-- Per-user model "likes"/favorites: quick access to frequently used models
-- from /models/liked. A join row keyed by (user, model); created_at orders
-- the liked list (most recently liked first). Cascades with either side so a
-- deleted user or model drops its likes. No backfill — likes start empty.
CREATE TABLE "model_likes" (
	"user_id" text NOT NULL,
	"model_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "model_likes_user_id_model_id_pk" PRIMARY KEY("user_id","model_id")
);
--> statement-breakpoint
ALTER TABLE "model_likes" ADD CONSTRAINT "model_likes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_likes" ADD CONSTRAINT "model_likes_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;
