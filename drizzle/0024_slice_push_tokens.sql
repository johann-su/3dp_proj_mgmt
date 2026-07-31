-- Slice-push tokens (issue #122).
--
-- Per-model credentials a slicer's post-processing hook presents to
-- POST /api/models/:id/slice-push, which attaches the just-sliced file as a
-- new revision. The slicer fetches without cookies, so this is the one *write*
-- surface that authenticates without a session — hence a stored, revocable
-- token rather than the stateless HMAC used for file downloads.
--
-- token_hash holds only the SHA-256 of the secret (a leaked database yields no
-- usable tokens); `prefix` keeps the secret's leading characters in clear so
-- the settings list can tell two tokens apart. Both FKs cascade: a token dies
-- with its model or with the account that issued it. Purely additive — no
-- existing table or row is touched, and a model with no token has no push
-- surface at all (the feature is opt-in, off by default).
CREATE TABLE "model_push_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"label" text,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "model_push_tokens_token_hash_unique" UNIQUE("token_hash")
);--> statement-breakpoint
ALTER TABLE "model_push_tokens" ADD CONSTRAINT "model_push_tokens_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_push_tokens" ADD CONSTRAINT "model_push_tokens_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- The model page lists a model's tokens on every load.
CREATE INDEX "model_push_tokens_model_idx" ON "model_push_tokens" USING btree ("model_id");
