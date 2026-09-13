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
  // filename character (control chars and quotes included). `%` is allowed:
  // platform imports routinely produce names like
  // "Bambu%20Print%20Orientations(1).3mf", and replacing it would mean a
  // pushed revision no longer matches the file it is a revision of.
  const base = raw.split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(/[^a-zA-Z0-9._ %()+-]/g, "_").trim();
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

// The caller naming the file it is replacing, rather than relying on the names
// matching. The plugin knows which file it resolved the model from, and the
// slicer's own output name is no help: on a Bambu printer the hook is handed a
// temp path (".<pid>.<n>.gcode") as *both* the artifact and the "output name",
// so a filename match can never happen. Replacing by id keeps the existing
// file's **name** — a sliced revision of `Bracket.3mf` is still `Bracket.3mf`,
// not a second row named after a slicer temp file.
//
// Restricted to the same artifact family: a `.gcode.3mf` bundle may replace a
// `.3mf` project (still a project file, now carrying slice data), but a raw
// `.gcode` may not — the model page's previews and slicer deep links are
// `.3mf`-gated, so that would quietly empty them. A mismatch falls back to the
// filename path rather than failing: the bytes are worth keeping either way.
export function findReplaceById<
  T extends { id: string; filename: string; kind: string; generatedFromId: string | null },
>(files: T[], fileId: string | null, artifact: PushArtifact): T | undefined {
  if (!fileId) return undefined;
  const target = files.find(
    (f) => f.id === fileId && f.kind === "model" && f.generatedFromId === null,
  );
  return target && pushArtifact(target.filename) === artifact ? target : undefined;
}

// --- Resolving a file on the slicing machine back to a model ---
//
// The whole reason the plugin needs no per-model setup. OrcaSlicer tells a
// plugin which files the open project was loaded from (`ModelObject.input_file`)
// and the Bambu design id it carries (`Model.design_id`); the plugin hashes
// those files and asks the instance which model they belong to. A file this
// catalogue served is byte-identical to the stored object, so the SHA-256 in
// `model_files.content_hash` (added for duplicate detection, issue #118, and
// indexed) is an exact answer — the filename and design-id paths below only
// exist for the cases where it isn't: a project re-saved in the slicer, or a
// file that predates content hashing.

// How a candidate was matched, best first. Ordering is the ranking.
// "search" is the manual escape hatch — a title the user typed — and is last
// precisely because it is not evidence of anything.
export const MATCH_CONFIDENCE = ["hash", "filename", "source", "search"] as const;
export type MatchConfidence = (typeof MATCH_CONFIDENCE)[number];

export type PushCandidate = {
  modelId: string;
  modelTitle: string;
  // The file the match landed on, when there is one — the plugin shows it so a
  // multi-file model doesn't look like a guess. Null for a design-id match,
  // which identifies the model but no particular file.
  fileId: string | null;
  filename: string | null;
  via: MatchConfidence;
};

// Collapses the three lookups into one ranked list, best match first and one
// entry per model: a model matched by both hash and filename is one candidate
// with the stronger reason, not two. Ties keep input order, which is the
// lookups' own ordering (most recently updated model first).
export function rankPushCandidates(matches: PushCandidate[]): PushCandidate[] {
  const best = new Map<string, PushCandidate>();
  for (const match of matches) {
    const existing = best.get(match.modelId);
    if (
      !existing ||
      MATCH_CONFIDENCE.indexOf(match.via) < MATCH_CONFIDENCE.indexOf(existing.via)
    ) {
      best.set(match.modelId, match);
    }
  }
  return [...best.values()].sort(
    (a, b) =>
      MATCH_CONFIDENCE.indexOf(a.via) - MATCH_CONFIDENCE.indexOf(b.via),
  );
}

// Whether the plugin may push without asking which model it is. Only an
// unambiguous hash match qualifies: pushing a revision to the wrong model is
// the one failure mode with no cheap undo, and a filename match ("part.3mf")
// is exactly the case where several models collide. Anything else goes to the
// dialog, where a human picks.
export function isConfidentMatch(candidates: PushCandidate[]): boolean {
  return candidates.length === 1 && candidates[0].via === "hash";
}

// A lowercase hex SHA-256, the form model_files.content_hash is stored in.
// Anything else is dropped before it reaches the query rather than rejected —
// the plugin sends whatever it could hash, and one unreadable file shouldn't
// fail the lookup for the rest.
export function isContentHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

// --- Slice metadata the plugin sends alongside the bytes ---
//
// A G-code footer says how long the print takes; it does not reliably say
// which printer, nozzle, plate or presets produced it. The plugin *can* read
// all of that from the live slicer (`orca.host.preset_bundle()` and the
// post-process step's config), so it sends a small JSON object in the
// X-Slice-Push-Meta header and the route folds it into the same `printerInfo`
// column the 3MF parser fills. That is why a pushed G-code shows the same
// printer/filament chips as an uploaded project file.
//
// Everything here is client-supplied and therefore parsed defensively: unknown
// keys are dropped, every field is optional, and a malformed header yields an
// empty result rather than an error — the bytes are worth storing even when
// the metadata is junk.

import type { PrinterInfo } from "@/db/schema";

// Header size limits are ~8KB; a printer name plus a handful of filament slots
// is a few hundred bytes. Anything past this is not metadata.
export const MAX_PUSH_META_BYTES = 4096;

function str(value: unknown, max = 120): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, max);
  return trimmed.length > 0 ? trimmed : undefined;
}

function strList(value: unknown, max = 16): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value
    .slice(0, max)
    .map((item) => str(item))
    .filter((item): item is string => item !== undefined);
  return list.length > 0 ? list : undefined;
}

function num(value: unknown, min: number, max: number): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? parsed
    : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

// Drops the keys whose value came out undefined, so a sparse push doesn't
// write `{"model": null}` over a column the 3MF parser filled more completely.
function compact(info: PrinterInfo): PrinterInfo | null {
  const entries = Object.entries(info).filter(([, v]) => v !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as PrinterInfo) : null;
}

export function parsePushMeta(header: string | null): PrinterInfo | null {
  if (!header || header.length > MAX_PUSH_META_BYTES) return null;
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(header);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    raw = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const presetsRaw =
    raw.presets && typeof raw.presets === "object" && !Array.isArray(raw.presets)
      ? (raw.presets as Record<string, unknown>)
      : {};
  const presets = compact({
    printer: str(presetsRaw.printer),
    process: str(presetsRaw.process),
    filaments: strList(presetsRaw.filaments),
  } as PrinterInfo);

  // Colours are index-parallel to filamentTypes by contract, so a mismatched
  // pair drops the colours rather than shifting them onto the wrong slot.
  const filamentTypes = strList(raw.filamentTypes);
  const filamentColorsRaw = strList(raw.filamentColors);
  const filamentColors =
    filamentColorsRaw && filamentTypes &&
    filamentColorsRaw.length === filamentTypes.length
      ? filamentColorsRaw.filter((c) => /^#[0-9a-fA-F]{6}$/.test(c))
      : undefined;

  const bedX = num((raw.bedSizeMm as Record<string, unknown>)?.x, 1, 10000);
  const bedY = num((raw.bedSizeMm as Record<string, unknown>)?.y, 1, 10000);

  return compact({
    model: str(raw.model),
    nozzleDiameterMm: num(raw.nozzleDiameterMm, 0.05, 5),
    bedType: str(raw.bedType),
    filamentTypes,
    filamentColors:
      filamentColors && filamentColors.length === filamentTypes?.length
        ? filamentColors
        : undefined,
    requiresMultiNozzle: bool(raw.requiresMultiNozzle),
    usesSupport: bool(raw.usesSupport),
    bedSizeMm: bedX !== undefined && bedY !== undefined ? { x: bedX, y: bedY } : undefined,
    presets: presets ?? undefined,
  } as PrinterInfo);
}
