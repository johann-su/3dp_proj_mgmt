-- Slice-push tokens (issue #122).
--
-- The credential the OrcaSlicer plugin (orca-plugin/) presents to the
-- slice-push endpoints, which resolve a file on the slicing machine back to a
-- model and attach the just-sliced artifact as a new revision. The slicer has
-- no session cookie, so these are the only *write* surfaces that authenticate
-- without a session — hence a stored, revocable token rather than the
-- stateless HMAC used for file downloads.
--
-- Scoped to a user and a machine, NOT to a model: the target is chosen inside
-- the slicer, so a per-model credential would mean re-pasting a command for
-- every model. token_hash holds only the SHA-256 of the secret (a leaked
-- database yields no usable tokens); `prefix` keeps the secret's leading
-- characters in clear so the settings list can tell two tokens apart. The FK
-- cascades: a token dies with the account that issued it. Purely additive — no
-- existing table or row is touched, and a user with no token has no push
-- surface at all (the feature is opt-in, off by default).
CREATE TABLE "push_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"label" text,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "push_tokens_token_hash_unique" UNIQUE("token_hash")
);--> statement-breakpoint
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
