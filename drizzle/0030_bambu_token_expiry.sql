-- Bambu Cloud token lifetime, so the app can remind users to renew their
-- login before MakerWorld downloads start failing. expires_at comes from the
-- login response (or the token's JWT claim) and stays null for connections
-- made before this was recorded; invalid_at is set when Bambu answers 401.
ALTER TABLE "bambu_credentials" ADD COLUMN IF NOT EXISTS "expires_at" timestamp;
ALTER TABLE "bambu_credentials" ADD COLUMN IF NOT EXISTS "invalid_at" timestamp;
