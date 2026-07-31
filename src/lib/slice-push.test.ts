import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findReplaceTarget,
  normalizePushFilename,
  pushArtifact,
} from "@/lib/slice-push";

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
