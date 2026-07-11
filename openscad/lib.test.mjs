import { test } from "node:test";
import assert from "node:assert/strict";
import { scrubErrorOutput, toParameterSetJson } from "./lib.mjs";

test("toParameterSetJson builds OpenSCAD's -p file shape", () => {
  // The service always renders parameter set "app" — the JSON must match what
  // `openscad -p params.json -P app` expects.
  const parsed = JSON.parse(toParameterSetJson({ arm_count: "4", label: "big" }));
  assert.deepEqual(parsed.parameterSets.app, { arm_count: "4", label: "big" });
});

test("toParameterSetJson allows $-prefixed special variables", () => {
  // BOSL2 tunables like $slop are legitimate customizer parameters.
  const parsed = JSON.parse(toParameterSetJson({ $slop: "0.2" }));
  assert.deepEqual(parsed.parameterSets.app, { $slop: "0.2" });
});

test("toParameterSetJson rejects names that are not OpenSCAD identifiers", () => {
  // Values never reach a command line, but a hostile *name* must not be able
  // to smuggle structure into the JSON or the .scad namespace.
  assert.throws(() => toParameterSetJson({ "a b": "1" }));
  assert.throws(() => toParameterSetJson({ "a=1;": "1" }));
  assert.throws(() => toParameterSetJson({ "": "1" }));
});

test("toParameterSetJson rejects non-string and oversized values", () => {
  assert.throws(() => toParameterSetJson({ a: 1 }));
  assert.throws(() => toParameterSetJson({ a: "x".repeat(201) }));
});

test("scrubErrorOutput returns the last meaningful line without temp paths", () => {
  const output = [
    "Compiling design (CSG Tree generation)...",
    "ECHO: \"debug\"",
    'ERROR: Parser error: syntax error in file /tmp/scad-Ab12Cd/input.scad, line 3',
    "",
  ].join("\n");
  const scrubbed = scrubErrorOutput(output);
  assert.ok(!scrubbed.includes("/tmp/"), scrubbed);
  assert.ok(scrubbed.includes("Parser error"), scrubbed);
});

test("scrubErrorOutput has a fallback for empty output", () => {
  assert.equal(scrubErrorOutput(""), "rendering produced no output");
});
