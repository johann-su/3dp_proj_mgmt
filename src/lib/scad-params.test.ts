import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseScadParameters,
  coerceScadValues,
  findForbiddenFileRefs,
  type ScadParameter,
} from "@/lib/scad-params";

function flat(source: string): ScadParameter[] {
  return parseScadParameters(source).flatMap((g) => g.parameters);
}

function byName(source: string, name: string): ScadParameter {
  const param = flat(source).find((p) => p.name === name);
  assert.ok(param, `parameter ${name} not found`);
  return param;
}

// A condensed servo-horn-like fixture exercising the full grammar.
const FIXTURE = `// Customizable Servo Horn
/* [Arm] */
// Number of arms on the horn
arm_count = 2; // [1:6]
// Arm length in mm
arm_length = 25.5; // [10:0.5:40]
label = "horn"; // 12

/* [Spline] */
tooth_count = 25; // [15:F small, 21:F medium, 25:F large]
material = "PLA"; // [PLA, PETG, ABS]
chamfer = true;
offsets = [1, 2, 3];

/* [Hidden] */
internal_fudge = 0.01;

module horn() { cylinder(h = arm_length); }
after_module = 99;
`;

test("parses numbers, strings, booleans and vectors with their defaults", () => {
  assert.deepEqual(byName(FIXTURE, "arm_count"), {
    name: "arm_count",
    type: "number",
    default: 2,
    description: "Number of arms on the horn",
    min: 1,
    max: 6,
  });
  assert.equal(byName(FIXTURE, "label").default, "horn");
  assert.equal(byName(FIXTURE, "chamfer").type, "boolean");
  assert.deepEqual(byName(FIXTURE, "offsets").default, [1, 2, 3]);
});

test("[min:step:max] annotation yields min, step and max", () => {
  const p = byName(FIXTURE, "arm_length");
  assert.equal(p.type, "number");
  assert.deepEqual([p.min, p.step, p.max], [10, 0.5, 40]);
});

test("value:label dropdowns keep numeric values with display labels", () => {
  const p = byName(FIXTURE, "tooth_count");
  assert.equal(p.type, "number");
  assert.deepEqual(p.options, [
    { value: 15, label: "F small" },
    { value: 21, label: "F medium" },
    { value: 25, label: "F large" },
  ]);
});

test("plain dropdown lists become string options", () => {
  const p = byName(FIXTURE, "material");
  assert.equal(p.type, "string");
  assert.deepEqual(
    p.options?.map((o) => o.value),
    ["PLA", "PETG", "ABS"],
  );
});

test("a bare number annotation on a string is its max length", () => {
  const p = byName(FIXTURE, "label");
  assert.equal(p.type, "string");
  assert.equal(p.maxLength, 12);
});

test("/* [Section] */ headers group parameters", () => {
  const groups = parseScadParameters(FIXTURE);
  assert.deepEqual(
    groups.map((g) => g.name),
    ["Arm", "Spline"],
  );
});

test("/* [Hidden] */ parameters are excluded", () => {
  // The Hidden section is the customizer's way to keep tunables out of the
  // UI — exposing them would let users set values the author considered
  // internal.
  assert.equal(flat(FIXTURE).find((p) => p.name === "internal_fudge"), undefined);
});

test("parsing stops at the first module — later assignments are not parameters", () => {
  assert.equal(flat(FIXTURE).find((p) => p.name === "after_module"), undefined);
});

test("expression values are skipped, literals around them still parse", () => {
  const source = `a = 1;\nb = a * 2;\nc = 3;\ncube(1);`;
  assert.deepEqual(
    flat(source).map((p) => p.name),
    ["a", "c"],
  );
});

test("geometry statements end parameter collection like modules do", () => {
  const source = `a = 1;\ncube([1,1,1]);\nb = 2;`;
  assert.deepEqual(
    flat(source).map((p) => p.name),
    ["a"],
  );
});

test("CRLF sources parse the same as LF", () => {
  const source = "/* [G] */\r\nx = 5; // [0:10]\r\ncube(1);\r\n";
  const p = byName(source, "x");
  assert.equal(p.type, "number");
  assert.deepEqual([p.min, p.max], [0, 10]);
});

test("annotation-like text inside strings does not confuse the parser", () => {
  // The default contains "//" and brackets — the real annotation follows the
  // semicolon.
  const source = `url = "https://x/[a]"; // 30\ncube(1);`;
  const p = byName(source, "url");
  assert.equal(p.type, "string");
  assert.equal(p.default, "https://x/[a]");
  assert.equal(p.maxLength, 30);
});

test("unrecognized annotations degrade to a plain input", () => {
  // The grammar is informal; an odd comment must never drop the parameter.
  const source = `x = 5; // TODO tidy this up\ncube(1);`;
  const p = byName(source, "x");
  assert.equal(p.type, "number");
  assert.equal(p.min, undefined);
});

// --- coercion ---------------------------------------------------------------

test("coerce clamps numbers into the annotated range", () => {
  const groups = parseScadParameters(FIXTURE);
  const out = coerceScadValues(groups, { arm_count: 99 });
  assert.equal(out.arm_count, "6");
});

test("coerce drops unknown names and non-option values", () => {
  const groups = parseScadParameters(FIXTURE);
  const out = coerceScadValues(groups, {
    not_a_param: 1,
    material: "TPU", // not in [PLA, PETG, ABS]
    tooth_count: 22, // not one of the labeled values
  });
  assert.deepEqual(out, {});
});

test("coerce omits values equal to the default — only diffs are rendered", () => {
  // Keeps parameter sets (and the dedupe hash) canonical: the same visible
  // configuration always produces the same map.
  const groups = parseScadParameters(FIXTURE);
  const out = coerceScadValues(groups, { arm_count: 2, material: "PETG" });
  assert.deepEqual(out, { material: "PETG" });
});

test("coerce strips quote/backslash from strings", () => {
  // A crafted string must not be able to escape OpenSCAD's string literal
  // when the parameter set is applied.
  const groups = parseScadParameters(`name = "x";\ncube(1);`);
  const out = coerceScadValues(groups, { name: 'a"; evil() //' });
  assert.equal(out.name, "a; evil() //");
});

test("coerce accepts vectors only with matching length and numeric entries", () => {
  const groups = parseScadParameters(FIXTURE);
  assert.deepEqual(coerceScadValues(groups, { offsets: [4, 5, 6] }), {
    offsets: "[4,5,6]",
  });
  assert.deepEqual(coerceScadValues(groups, { offsets: [4, 5] }), {});
  assert.deepEqual(coerceScadValues(groups, { offsets: [4, 5, "x"] }), {});
});

test("coerce accepts booleans as booleans or 'true'/'false' strings", () => {
  const groups = parseScadParameters(FIXTURE);
  assert.deepEqual(coerceScadValues(groups, { chamfer: false }), { chamfer: "false" });
  assert.deepEqual(coerceScadValues(groups, { chamfer: "false" }), { chamfer: "false" });
  assert.deepEqual(coerceScadValues(groups, { chamfer: "yes" }), {});
});

// --- forbidden refs ---------------------------------------------------------

test("bundled library includes are allowed", () => {
  const source = `include <BOSL2/std.scad>\nuse <MCAD/gears.scad>\nx = 1;\ncube(1);`;
  assert.deepEqual(findForbiddenFileRefs(source), []);
});

test("path traversal and absolute includes are rejected", () => {
  assert.ok(findForbiddenFileRefs(`include <../../etc/passwd>`).length > 0);
  assert.ok(findForbiddenFileRefs(`include </etc/passwd>`).length > 0);
  assert.ok(findForbiddenFileRefs(`use <C:\\windows\\x.scad>`).length > 0);
});

test("sibling-file includes are rejected — multi-file projects are unsupported", () => {
  const violations = findForbiddenFileRefs(`include <helpers.scad>`);
  assert.equal(violations.length, 1);
});

test("import() and surface() are always rejected, even with dynamic paths", () => {
  // There is no file the source could legitimately reference — the render
  // temp dir contains only the uploaded source.
  assert.ok(findForbiddenFileRefs(`import("model.stl");`).length > 0);
  assert.ok(findForbiddenFileRefs(`p = "x"; import(str(p, ".stl"));`).length > 0);
  assert.ok(findForbiddenFileRefs(`surface(file = "map.png");`).length > 0);
});

test("include mentioned in a comment is not a violation", () => {
  const source = `// works with include <../lib.scad> if you have it\nx = 1;\ncube(1);`;
  assert.deepEqual(findForbiddenFileRefs(source), []);
});
