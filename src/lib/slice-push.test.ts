import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findReplaceById,
  findReplaceTarget,
  isConfidentMatch,
  isContentHash,
  normalizePushFilename,
  parsePushMeta,
  parsePushStats,
  pushArtifact,
  rankPushCandidates,
  type PushCandidate,
} from "@/lib/slice-push";

const candidate = (over: Partial<PushCandidate>): PushCandidate => ({
  modelId: "m1",
  modelTitle: "Bracket",
  fileId: "f1",
  filename: "Bracket.3mf",
  via: "hash",
  ...over,
});

test("routes each artifact to the parser that can read it", () => {
  // .gcode is what the post-processing hook actually hands over; the 3MF
  // parsers get both a plain project and a Bambu .gcode.3mf bundle.
  assert.equal(pushArtifact("Benchy.gcode"), "gcode");
  assert.equal(pushArtifact("Benchy.3mf"), "3mf");
  assert.equal(pushArtifact("plate_1.gcode.3mf"), "3mf");
  assert.equal(pushArtifact("Benchy.GCODE"), "gcode");
  // Anything else is refused rather than stored as an opaque blob.
  assert.equal(pushArtifact("Benchy.stl"), null);
  assert.equal(pushArtifact("Benchy"), null);
});

test("a pushed filename is reduced to a bare, safe filename", () => {
  // The value comes from a path on the pusher's machine.
  assert.equal(normalizePushFilename("/tmp/slice/Benchy.gcode"), "Benchy.gcode");
  assert.equal(
    normalizePushFilename("C:\\Users\\jo\\Desktop\\Benchy.gcode"),
    "Benchy.gcode",
  );
  assert.equal(normalizePushFilename("Bracket v2 (0.2mm).3mf"), "Bracket v2 (0.2mm).3mf");
});

test("path traversal and control characters cannot survive normalization", () => {
  // model_files.filename ends up in an export zip's entry names and in a
  // Content-Disposition header, so "../" must never reach either.
  assert.equal(normalizePushFilename("../../etc/passwd.gcode"), "passwd.gcode");
  assert.equal(normalizePushFilename(".."), null);
  assert.equal(normalizePushFilename(""), null);
  assert.equal(normalizePushFilename(null), null);
  // Quotes/newlines would break out of the header; they're replaced, and the
  // result still has to end in an allowed extension.
  assert.equal(normalizePushFilename('a"b\n.gcode'), "a_b_.gcode");
  assert.equal(normalizePushFilename("evil.gcode.exe"), null);
});

test("a repeat push of the same plate replaces that file, not appends", () => {
  // Re-slicing exports the same name every time; appending instead would pile
  // up near-identical rows and churn through the 30-version history.
  const files = [
    { id: "a", filename: "Bracket.3mf", kind: "model", generatedFromId: null },
    { id: "b", filename: "manual.pdf", kind: "pdf", generatedFromId: null },
  ];
  assert.equal(findReplaceTarget(files, "bracket.3mf")?.id, "a");
  assert.equal(findReplaceTarget(files, "Other.3mf"), undefined);
  // A same-named PDF is not a replace target — kind must match too.
  assert.equal(findReplaceTarget(files, "manual.pdf"), undefined);
});

test("a generated OpenSCAD variant is never overwritten by a push", () => {
  // Variants are excluded from version snapshots, so replacing one would drop
  // bytes no snapshot could restore.
  const files = [
    { id: "v", filename: "Part (n=4).3mf", kind: "model", generatedFromId: "src" },
  ];
  assert.equal(findReplaceTarget(files, "Part (n=4).3mf"), undefined);
});

test("one model matched twice keeps its strongest reason, not both rows", () => {
  // A project opened from the catalogue matches by hash *and* by filename;
  // showing it twice would read as two different models.
  const ranked = rankPushCandidates([
    candidate({ via: "filename" }),
    candidate({ via: "hash" }),
    candidate({ modelId: "m2", modelTitle: "Other", via: "filename" }),
  ]);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].modelId, "m1");
  assert.equal(ranked[0].via, "hash");
  // Best reason first, so the plugin can offer the top one as the default.
  assert.equal(ranked[1].via, "filename");
});

test("only a single exact-file match is pushed to without asking", () => {
  // Pushing a revision to the wrong model is the one mistake with no cheap
  // undo, and "part.3mf" is exactly where several models collide.
  assert.equal(isConfidentMatch([candidate({})]), true);
  assert.equal(isConfidentMatch([candidate({ via: "filename" })]), false);
  assert.equal(isConfidentMatch([candidate({ via: "source" })]), false);
  assert.equal(
    isConfidentMatch([candidate({}), candidate({ modelId: "m2" })]),
    false,
  );
  assert.equal(isConfidentMatch([]), false);
});

test("only a lowercase hex sha-256 reaches the content-hash lookup", () => {
  // The plugin sends whatever it could hash; anything else is dropped rather
  // than rejected, so one unreadable file doesn't fail the whole lookup.
  assert.equal(isContentHash("a".repeat(64)), true);
  assert.equal(isContentHash("A".repeat(64)), false);
  assert.equal(isContentHash("a".repeat(63)), false);
  assert.equal(isContentHash(null), false);
});

test("slice metadata keeps only what it can vouch for", () => {
  // Everything here is client-supplied, so unknown keys are dropped and a
  // malformed header yields nothing rather than an error.
  const info = parsePushMeta(
    JSON.stringify({
      model: "Bambu Lab P1S",
      nozzleDiameterMm: 0.4,
      filamentTypes: ["PLA", "PETG"],
      filamentColors: ["#e02020", "#000000"],
      usesSupport: true,
      presets: { printer: "P1S 0.4", process: "0.20 Standard", filaments: ["Generic PLA"] },
      somethingElse: "dropped",
    }),
  );
  assert.equal(info?.model, "Bambu Lab P1S");
  assert.equal(info?.nozzleDiameterMm, 0.4);
  assert.deepEqual(info?.filamentColors, ["#e02020", "#000000"]);
  assert.equal(info?.presets?.process, "0.20 Standard");
  assert.equal("somethingElse" in (info ?? {}), false);
});

test("filament colours are dropped rather than shifted onto the wrong slot", () => {
  // The two arrays are index-parallel by contract; a mismatched pair would
  // paint slot 2's colour onto slot 1.
  const info = parsePushMeta(
    JSON.stringify({ filamentTypes: ["PLA", "PETG"], filamentColors: ["#e02020"] }),
  );
  assert.deepEqual(info?.filamentTypes, ["PLA", "PETG"]);
  assert.equal(info?.filamentColors, undefined);
});

test("junk metadata never costs us the bytes", () => {
  // The file is worth storing even when the header is nonsense.
  assert.equal(parsePushMeta("not json"), null);
  assert.equal(parsePushMeta("[1,2,3]"), null);
  assert.equal(parsePushMeta(null), null);
  assert.equal(parsePushMeta("{}"), null);
  // Out-of-range numbers are dropped, not clamped: a 90 mm "nozzle" is a bug
  // somewhere, and a wrong number is worse than a missing one.
  assert.equal(parsePushMeta(JSON.stringify({ nozzleDiameterMm: 90 })), null);
});

test("a synced project may carry the estimate its own slice_info lacks", () => {
  // OrcaSlicer rewrites its project checkpoint when the *model* changes, not
  // when a slice finishes, so a pushed project can hold the previous slice's
  // predictions or none at all. The plugin parses the G-code footer it was
  // handed and sends the pair; the route applies it only if the file itself
  // yields nothing.
  const stats = parsePushStats(
    JSON.stringify({ model: "Bambu Lab P1S", printTimeSeconds: 18004, filamentGrams: 21.65 }),
  );
  assert.equal(stats?.printTimeSeconds, 18004);
  assert.equal(stats?.filamentGrams, 21.65);

  // Metadata with no numbers in it is not an estimate of zero.
  assert.equal(parsePushStats(JSON.stringify({ model: "Bambu Lab P1S" })), null);
  assert.equal(parsePushStats("not json"), null);
  // A weight with no time cannot resolve a file to "ok", but it is still the
  // filament figure the slicer reported.
  const weightOnly = parsePushStats(JSON.stringify({ filamentGrams: 12.5 }));
  assert.equal(weightOnly?.printTimeSeconds, null);
  assert.equal(weightOnly?.filamentGrams, 12.5);
  // Out of range is dropped rather than clamped, as everywhere else in this
  // header: a print of negative length is a bug, not a fast print.
  assert.equal(parsePushStats(JSON.stringify({ printTimeSeconds: -5 })), null);
});

test("a push names the file it revises, so the revision keeps that name", () => {
  // The slicer is no help here: on a Bambu printer the hook is handed a temp
  // path (".<pid>.<n>.gcode") as both the artifact and the output name, so a
  // filename match can never happen — the pusher has to say which file it is
  // revising.
  const files = [
    { id: "f1", filename: "Bracket.3mf", kind: "model", generatedFromId: null },
    { id: "f2", filename: "notes.pdf", kind: "pdf", generatedFromId: null },
  ];
  assert.equal(findReplaceById(files, "f1", "3mf")?.filename, "Bracket.3mf");
  // A .gcode may not take over a .3mf row: the 3D preview and slicer deep
  // links are .3mf-gated and would quietly go empty.
  assert.equal(findReplaceById(files, "f1", "gcode"), undefined);
  // Not a model file, unknown id, or no hint at all.
  assert.equal(findReplaceById(files, "f2", "3mf"), undefined);
  assert.equal(findReplaceById(files, "nope", "3mf"), undefined);
  assert.equal(findReplaceById(files, null, "3mf"), undefined);
});

test("percent signs survive normalization", () => {
  // Platform imports routinely produce these names; mangling them would mean a
  // pushed revision no longer matches the file it revises.
  assert.equal(
    normalizePushFilename("Bambu%20Print%20Orientations(1).3mf"),
    "Bambu%20Print%20Orientations(1).3mf",
  );
});

test("a model the user searched for ranks below anything the file itself said", () => {
  // Search is what someone typed, not evidence about the file — it exists so a
  // project the catalogue cannot recognise can still be pushed, and it must
  // never outrank (or stand in for) a real match.
  const ranked = rankPushCandidates([
    candidate({ modelId: "m2", via: "search" }),
    candidate({ modelId: "m1", via: "filename" }),
  ]);
  assert.deepEqual(ranked.map((c) => c.via), ["filename", "search"]);
  assert.equal(isConfidentMatch([candidate({ via: "search" })]), false);
});
