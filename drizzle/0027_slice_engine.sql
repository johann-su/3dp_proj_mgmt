-- Which slicer produced a file's print estimate ("OrcaSlicer 2.4.2",
-- "Bambu Studio 02.08.02.61"), and — for files without printer settings of
-- their own — the slicer service's generic printer the estimate assumed.
-- Both fill in as files are (re-)sliced; existing rows stay null.
ALTER TABLE "model_files" ADD COLUMN IF NOT EXISTS "slice_engine" text;
ALTER TABLE "model_files" ADD COLUMN IF NOT EXISTS "slice_printer" text;
