-- Instance-wide user roles (issue #54): 'user' | 'moderator' | 'admin'.
-- Moderators and admins pass the owner-only gates on all models/collections
-- (owner-equivalent for cleanup); admins additionally manage users on
-- Settings → Users. The first admin is designated via INITIAL_ADMIN_EMAIL —
-- see src/lib/admin.ts.
ALTER TABLE "user" ADD COLUMN "role" text DEFAULT 'user' NOT NULL;
