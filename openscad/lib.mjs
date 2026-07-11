// Pure helpers for the OpenSCAD render service — no I/O, unit-tested from the
// repo root via `npm test` (like slicer/lib.mjs).

const NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MAX_PARAMETERS = 200;
const MAX_VALUE_LENGTH = 200;

// Builds the JSON body for OpenSCAD's `-p params.json -P app` parameter-set
// mechanism. Values only ever travel through this JSON — never through -D or
// any other command-line interpolation — so a hostile value can at worst be a
// weird parameter value, not an extra CLI flag. Throws on input the app
// should never send (invalid names, non-string values, absurd counts); the
// server maps that to a 400.
export function toParameterSetJson(parameters) {
  if (
    parameters === null ||
    typeof parameters !== "object" ||
    Array.isArray(parameters)
  ) {
    throw new Error("parameters must be an object");
  }
  const entries = Object.entries(parameters);
  if (entries.length > MAX_PARAMETERS) {
    throw new Error(`too many parameters (max ${MAX_PARAMETERS})`);
  }
  const set = {};
  for (const [name, value] of entries) {
    if (!NAME_PATTERN.test(name)) {
      throw new Error(`invalid parameter name: ${JSON.stringify(name.slice(0, 50))}`);
    }
    if (typeof value !== "string") {
      throw new Error(`parameter ${name} must be a string`);
    }
    if (value.length > MAX_VALUE_LENGTH) {
      throw new Error(`parameter ${name} value too long (max ${MAX_VALUE_LENGTH})`);
    }
    set[name] = value;
  }
  return JSON.stringify({ parameterSets: { app: set }, fileFormatVersion: "1" });
}

// Last meaningful line of the OpenSCAD output for failure messages. Temp
// paths mean nothing to the caller; ECHO lines are the model talking, not the
// error.
export function scrubErrorOutput(output) {
  const lines = output
    .split("\n")
    .map((line) => line.trim().replace(/\/tmp\/scad-[^\s:,')]*\/?/g, ""))
    .filter((line) => line && !line.startsWith("ECHO:"));
  return lines.at(-1) ?? "rendering produced no output";
}
