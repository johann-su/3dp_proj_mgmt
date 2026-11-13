// Pure helpers for the OpenSCAD render service — no I/O, unit-tested from the repo root via `npm test` (like slicer/lib.mjs).

const NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MAX_PARAMETERS = 200;
const MAX_VALUE_LENGTH = 200;

// Builds the JSON body for OpenSCAD's `-p params.json -P app` parameter-set mechanism. Values only ever travel through this JSON — never through -D or any other command-line interpolation — so a hostile value can at worst be a weird parameter value, not an extra CLI flag. Throws on input the app should never send (invalid names, non-string values, absurd counts); the server maps that to a 400.
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

// Runs jobs one at a time, in arrival order (rendering is CPU-bound). A job whose signal is aborted by the time its turn comes is skipped and resolves to null: the customizer fires a preview per parameter change and abandons the older ones, and without the skip every abandoned preview would still be rendered in turn before the one the user is waiting for. A failing job doesn't stall the queue.
export function createSerialQueue() {
  let tail = Promise.resolve();
  return function enqueue(job, signal) {
    const run = tail.then(() => (signal?.aborted ? null : job()));
    tail = run.then(
      () => {},
      () => {},
    );
    return run;
  };
}

// The failure message for the caller: the last ERROR line, else the last meaningful line of the OpenSCAD output. OpenSCAD keeps talking after an error (a failed assert is followed by "TRACE: ..." and "Current top level object is empty."), so the plain last line is often not the cause. Temp paths mean nothing to the caller; ECHO lines are the model talking, not the error.
export function scrubErrorOutput(output) {
  const lines = output
    .split("\n")
    .map((line) => line.trim().replace(/\/tmp\/scad-[^\s:,')]*\/?/g, ""))
    .filter((line) => line && !line.startsWith("ECHO:"));
  return (
    lines.findLast((line) => line.startsWith("ERROR:")) ??
    lines.at(-1) ??
    "rendering produced no output"
  );
}
