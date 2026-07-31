// Pure helpers for the slice-push ingest route (issue #122). Kept out of the
// route so they can be unit-tested without a DB pool or an S3 client.

import { fileExtension } from "@/lib/file-kind";

// What a slicer's post-processing hook is allowed to push.
//
// `.gcode` is the artifact OrcaSlicer/PrusaSlicer actually hand a
// post-processing script: the hook runs on the temporary G-code *before* the
// file is exported to its final destination (BackgroundSlicingProcess::
// finalize_gcode), so at hook time no project or `.gcode.3mf` bundle exists
// yet. `.3mf` covers the other half — a project file pushed by hand, or a
// Bambu-style `.gcode.3mf` bundle, both of which the existing 3MF parsers
// already read for real per-plate predictions.
//
// Deliberately NOT added to MODEL_EXTENSIONS: this list widens what a *token
// holder* may attach to one model, not what the upload form accepts, and
// `.gcode` has no place in the create/edit picker.
export const PUSH_EXTENSIONS = [".3mf", ".gcode"];

export type PushArtifact = "3mf" | "gcode";

// Which parser the pushed bytes are routed to. `.gcode.3mf` ends in `.3mf`
// and is a ZIP, so it lands on the 3MF path — which is what we want.
export function pushArtifact(filename: string): PushArtifact | null {
  const ext = fileExtension(filename);
  if (ext === ".3mf") return "3mf";
  if (ext === ".gcode") return "gcode";
  return null;
}

// The filename arrives as a query param filled in from a path on the pusher's
// machine, so it may carry directories ("/tmp/xyz/Benchy.gcode", or a Windows
// "C:\\Users\\…\\Benchy.gcode"). Reduce it to a bare, safe filename or reject
// it: it is stored on model_files and echoed into Content-Disposition, and a
// "../" in it would escape the folder an export zip extracts into.
export function normalizePushFilename(raw: string | null): string | null {
  if (!raw) return null;
  // Last segment of either separator, then drop anything that isn't a plain
  // filename character (control chars and quotes included).
  const base = raw.split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(/[^a-zA-Z0-9._ ()+-]/g, "_").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return null;
  const capped = cleaned.slice(0, 200);
  return pushArtifact(capped) ? capped : null;
}

// Whether a pushed file replaces one already on the model. Matched on filename
// (case-insensitively, the way a filesystem would), because re-slicing the
// same plate exports the same name every time — so repeated pushes become
// successive revisions of one file instead of piling up near-identical rows
// and churning through the model's 30-version history.
//
// Only ever matches a real model file: generated OpenSCAD variants belong to
// their .scad source and are excluded from version snapshots, so overwriting
// one would drop bytes no snapshot could restore.
export function findReplaceTarget<
  T extends { filename: string; kind: string; generatedFromId: string | null },
>(files: T[], filename: string): T | undefined {
  const target = filename.toLowerCase();
  return files.find(
    (f) =>
      f.kind === "model" &&
      f.generatedFromId === null &&
      f.filename.toLowerCase() === target,
  );
}
