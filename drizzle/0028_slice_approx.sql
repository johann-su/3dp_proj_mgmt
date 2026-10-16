-- Whether a stored estimate is approximate (shown with "~"): the slicer
-- service sliced the file under assumptions it didn't make — its generic
-- printer, PrusaSlicer settings translated onto OrcaSlicer, or project
-- settings it had to repair. False for a Bambu/Orca project sliced natively
-- and for estimates read from the file itself. Null on rows estimated before
-- this was recorded; those keep the old rule (approximate if the slicer
-- service produced them) until re-sliced.
ALTER TABLE "model_files" ADD COLUMN IF NOT EXISTS "slice_approx" boolean;
