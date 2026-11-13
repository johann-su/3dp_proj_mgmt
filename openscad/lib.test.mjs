import { test } from "node:test";
import assert from "node:assert/strict";
import { createSerialQueue, scrubErrorOutput, toParameterSetJson } from "./lib.mjs";

test("toParameterSetJson builds OpenSCAD's -p file shape", () => {
  // The service always renders parameter set "app" — the JSON must match what `openscad -p params.json -P app` expects.
  const parsed = JSON.parse(toParameterSetJson({ arm_count: "4", label: "big" }));
  assert.deepEqual(parsed.parameterSets.app, { arm_count: "4", label: "big" });
});

test("toParameterSetJson allows $-prefixed special variables", () => {
  // BOSL2 tunables like $slop are legitimate customizer parameters.
  const parsed = JSON.parse(toParameterSetJson({ $slop: "0.2" }));
  assert.deepEqual(parsed.parameterSets.app, { $slop: "0.2" });
});

test("toParameterSetJson rejects names that are not OpenSCAD identifiers", () => {
  // Values never reach a command line, but a hostile *name* must not be able to smuggle structure into the JSON or the .scad namespace.
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

test("scrubErrorOutput prefers the error over OpenSCAD's trailing chatter", () => {
  // Real output of a failed assert: the useful line is the ERROR, not the "empty top level object" that follows it.
  const output = [
    "ERROR: Assertion '(x < 2)' failed: \"x too big\" in file input.scad, line 2",
    "TRACE: called by 'assert' in file input.scad, line 2",
    "Current top level object is empty.",
  ].join("\n");
  assert.match(scrubErrorOutput(output), /Assertion .* failed/);
});

test("scrubErrorOutput falls back to the last line when there is no ERROR", () => {
  // An empty model fails without an ERROR line; its last line is the explanation.
  assert.equal(
    scrubErrorOutput("Compiling design...\nCurrent top level object is empty.\n"),
    "Current top level object is empty.",
  );
});

test("scrubErrorOutput has a fallback for empty output", () => {
  assert.equal(scrubErrorOutput(""), "rendering produced no output");
});

test("createSerialQueue runs jobs one at a time, in order", async () => {
  // Rendering is CPU-bound: a second job must not start before the first finishes.
  const enqueue = createSerialQueue();
  const events = [];
  const job = (name) => async () => {
    events.push(`start ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    events.push(`end ${name}`);
    return name;
  };
  const results = await Promise.all([enqueue(job("a")), enqueue(job("b"))]);
  assert.deepEqual(results, ["a", "b"]);
  assert.deepEqual(events, ["start a", "end a", "start b", "end b"]);
});

test("createSerialQueue skips a queued job whose client went away", async () => {
  // A preview superseded while waiting in line must never reach OpenSCAD.
  const enqueue = createSerialQueue();
  const controller = new AbortController();
  let release;
  let started;
  const firstStarted = new Promise((resolve) => (started = resolve));
  const first = enqueue(() => {
    started();
    return new Promise((resolve) => (release = resolve));
  });
  let ran = false;
  const second = enqueue(() => {
    ran = true;
  }, controller.signal);
  await firstStarted;
  controller.abort();
  release("done");
  assert.equal(await first, "done");
  assert.equal(await second, null);
  assert.equal(ran, false);
});

test("createSerialQueue keeps going after a failing job", async () => {
  const enqueue = createSerialQueue();
  const failed = enqueue(async () => {
    throw new Error("boom");
  });
  await assert.rejects(failed);
  assert.equal(await enqueue(async () => "next"), "next");
});
