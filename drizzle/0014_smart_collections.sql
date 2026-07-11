-- Smart collections (#46): rule-based membership evaluated at read time.
-- `rules` holds the validated AND/OR rule tree (src/lib/collection-rules.ts);
-- it is only meaningful while `smart` is true. collection_models stays the
-- storage for hand-curated collections.
ALTER TABLE "collections" ADD COLUMN "smart" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "rules" jsonb;
