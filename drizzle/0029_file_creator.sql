-- The application that created a model file ("Bambu Studio" 02.08.02.61,
-- "OrcaSlicer" 2.4.2, "PrusaSlicer" 2.9.2, "Onshape", "OpenSCAD"), from the
-- .3mf's own metadata or — for CAD exports without any — how the file got
-- here (src/lib/file-creator.ts). Lets slicing be routed to a matching
-- backend later. Not the slicer behind the estimate (slice_engine). Filled
-- on upload/re-slice; existing rows: scripts/backfill-file-creator.ts.
ALTER TABLE "model_files" ADD COLUMN IF NOT EXISTS "creator_app" text;
ALTER TABLE "model_files" ADD COLUMN IF NOT EXISTS "creator_version" text;
