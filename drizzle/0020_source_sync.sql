-- Upstream source sync for MakerWorld/Printables: per-file upstream identity
-- and last-modified token, stamped at import and refreshed on every sync.
--
-- source_file_id ("profile:<id>" / "scad:<name>" / "doc:<name>" /
-- "file:<id>") is how sync matches local imported files to the upstream file
-- list — the MakerWorld/Printables sibling of onshape_element_id.
-- source_modified_at holds the platform's per-file last-modified value as an
-- opaque string; sync re-downloads a matched file only when the upstream
-- value differs.
--
-- No backfill: upstream ids are unknowable for existing rows. The first sync
-- of a pre-feature import adopts files by filename and stamps both columns.
ALTER TABLE "model_files" ADD COLUMN "source_file_id" text;
--> statement-breakpoint
ALTER TABLE "model_files" ADD COLUMN "source_modified_at" text;
