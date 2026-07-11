// OpenSCAD customizer parameter parsing — pure string logic, no DB/S3 (the
// S3 wiring lives in the model page / customize route, mirroring the
// threemf-slice-info.ts / threemf-remote.ts split).
//
// The customizer "schema" is OpenSCAD's informal comment grammar
// (https://en.wikibooks.org/wiki/OpenSCAD_User_Manual/Customizer): top-level
// literal assignments become parameters, an optional trailing comment
// annotates the widget, `/* [Section] */` starts a group and `/* [Hidden] */`
// hides everything after it. MakerWorld's parametric models use exactly this
// grammar (their design API's scadConfig field is empty in practice, so the
// source is the only schema we can rely on).

export type ScadParameterOption<V> = { value: V; label: string };

export type ScadParameter =
  | {
      name: string;
      type: "number";
      default: number;
      description?: string;
      min?: number;
      max?: number;
      step?: number;
      options?: ScadParameterOption<number>[];
    }
  | { name: string; type: "boolean"; default: boolean; description?: string }
  | {
      name: string;
      type: "string";
      default: string;
      description?: string;
      maxLength?: number;
      options?: ScadParameterOption<string>[];
    }
  | {
      name: string;
      type: "vector";
      default: number[];
      description?: string;
      min?: number;
      max?: number;
      step?: number;
    };

export type ScadParameterGroup = {
  // null = parameters before the first /* [Section] */ header
  name: string | null;
  parameters: ScadParameter[];
};

const STRING_MAX_LENGTH = 200;
const VALUE_MAX_LENGTH = 200;
const MAX_PARAMETERS = 200;

// --- tokenizing helpers -----------------------------------------------------

// Strips block comments and string bodies so structural scans (first module/
// geometry statement, include targets) can't be fooled by comment or string
// content, while keeping offsets intact by replacing with spaces.
function blankNonCode(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (ch === "/" && source[i + 1] === "/") {
      let stop = source.indexOf("\n", i);
      if (stop === -1) stop = source.length;
      out += " ".repeat(stop - i);
      i = stop;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') {
        if (source[j] === "\\") j += 1;
        j += 1;
      }
      const stop = Math.min(j + 1, source.length);
      out += '"' + " ".repeat(Math.max(0, stop - i - 2)) + (stop - i >= 2 ? '"' : "");
      i = stop;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

// Parses one literal: number, boolean, quoted string, or vector of numbers.
// Returns null for anything else (expressions are not customizer params).
function parseLiteral(
  raw: string,
): { type: "number"; value: number } | { type: "boolean"; value: boolean } | { type: "string"; value: string } | { type: "vector"; value: number[] } | null {
  const text = raw.trim();
  if (text === "true" || text === "false") {
    return { type: "boolean", value: text === "true" };
  }
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text)) {
    return { type: "number", value: Number(text) };
  }
  const str = text.match(/^"((?:[^"\\]|\\.)*)"$/);
  if (str) {
    return { type: "string", value: str[1].replace(/\\(.)/g, "$1").slice(0, STRING_MAX_LENGTH) };
  }
  const vec = text.match(/^\[([^\]]*)\]$/);
  if (vec) {
    const parts = vec[1].split(",").map((p) => p.trim());
    if (parts.length === 0 || parts.some((p) => !/^-?\d+(\.\d+)?$/.test(p))) return null;
    return { type: "vector", value: parts.map(Number) };
  }
  return null;
}

// --- annotation parsing -----------------------------------------------------

type Annotation =
  | { kind: "range"; min: number; max: number; step?: number }
  | { kind: "maxOnly"; max: number }
  | { kind: "options"; options: ScadParameterOption<string>[] }
  | { kind: "maxLength"; maxLength: number }
  | null;

// Parses the trailing `// …` widget annotation. Unrecognized shapes return
// null — the parameter degrades to a plain input, never an error.
function parseAnnotation(comment: string): Annotation {
  const text = comment.trim();
  if (!text) return null;

  // `// 12` on a string parameter = max length; on numbers OpenSCAD treats a
  // bare number as a spin-box step, which we fold into maxLength/step later.
  if (/^\d+(\.\d+)?$/.test(text)) {
    return { kind: "maxLength", maxLength: Number(text) };
  }

  const bracket = text.match(/^\[([^]*)\]$/);
  if (!bracket) return null;
  const body = bracket[1].trim();
  if (!body) return null;

  // [max] / [min:max] / [min:step:max] — all-numeric colon forms
  const colonParts = body.split(":").map((p) => p.trim());
  if (colonParts.every((p) => /^-?\d+(\.\d+)?$/.test(p))) {
    if (colonParts.length === 1) return { kind: "maxOnly", max: Number(colonParts[0]) };
    if (colonParts.length === 2)
      return { kind: "range", min: Number(colonParts[0]), max: Number(colonParts[1]) };
    if (colonParts.length === 3)
      return {
        kind: "range",
        min: Number(colonParts[0]),
        step: Number(colonParts[1]),
        max: Number(colonParts[2]),
      };
    return null;
  }

  // [a, b, c] or [value:label, value:label] dropdowns
  const options: ScadParameterOption<string>[] = [];
  for (const part of body.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const labeled = entry.match(/^([^:]+):(.+)$/);
    if (labeled) {
      options.push({ value: labeled[1].trim(), label: labeled[2].trim() });
    } else {
      options.push({ value: entry, label: entry });
    }
  }
  return options.length > 0 ? { kind: "options", options } : null;
}

// --- main parser ------------------------------------------------------------

// Customizer parameters are only the top-level assignments before the first
// module/function definition or geometry statement — OpenSCAD itself stops
// collecting there, and so do we. We scan line-groups: section headers,
// comments (descriptions), assignments, and stop markers.
export function parseScadParameters(source: string): ScadParameterGroup[] {
  const code = blankNonCode(source);
  const lines = source.split(/\r?\n/);
  const codeLines = code.split(/\r?\n/);

  const groups: ScadParameterGroup[] = [];
  let current: ScadParameterGroup = { name: null, parameters: [] };
  let hidden = false;
  let pendingDescription: string[] = [];
  let total = 0;

  const pushGroup = () => {
    if (current.parameters.length > 0) groups.push(current);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const codeLine = codeLines[i];
    const trimmed = line.trim();

    // Stop at the first module/function definition or geometry/control
    // statement: nothing below is a customizer parameter. Detect on the
    // comment/string-blanked code so text inside comments can't trigger it.
    const codeTrimmed = codeLine.trim();
    if (
      /^(module|function)\b/.test(codeTrimmed) ||
      /^[a-zA-Z_$][\w$]*\s*\(/.test(codeTrimmed) || // cube(…), translate(…), echo(…)
      /^(if|for|intersection_for|let)\b/.test(codeTrimmed) ||
      /^[{}]/.test(codeTrimmed)
    ) {
      break;
    }

    // Section headers: /* [Name] */ — [Hidden] hides all following params.
    const section = trimmed.match(/^\/\*\s*\[(.+?)\]\s*\*\/$/);
    if (section) {
      pushGroup();
      const name = section[1].trim();
      hidden = name.toLowerCase() === "hidden";
      current = { name: hidden ? null : name, parameters: [] };
      pendingDescription = [];
      continue;
    }

    // Plain comment line: accumulates as the next parameter's description.
    if (trimmed.startsWith("//")) {
      pendingDescription.push(trimmed.replace(/^\/\/\s?/, "").trim());
      continue;
    }

    if (trimmed === "") {
      pendingDescription = [];
      continue;
    }

    // Assignment? Use the blanked code line to find the terminating `;` and
    // the original line for the value + trailing annotation comment.
    const assign = codeLine.match(/^\s*([a-zA-Z_$][\w$]*)\s*=/);
    if (!assign) {
      pendingDescription = [];
      continue;
    }
    const name = assign[1];
    const eq = line.indexOf("=");
    const semi = codeLine.indexOf(";", eq);
    if (semi === -1) {
      // multi-line expression — not a literal parameter
      pendingDescription = [];
      continue;
    }
    const rawValue = line.slice(eq + 1, semi);
    const afterSemi = line.slice(semi + 1);
    const annotationMatch = afterSemi.match(/\/\/\s?(.*)$/);
    const literal = parseLiteral(rawValue);
    const description = pendingDescription.join(" ").trim() || undefined;
    pendingDescription = [];

    if (!literal || hidden || name === "$fn" || total >= MAX_PARAMETERS) continue;
    // OpenSCAD ignores re-assignments of the same name for the customizer
    // (last value wins in the language, first wins in the UI) — keep first.
    if (current.parameters.some((p) => p.name === name)) continue;

    const annotation = annotationMatch ? parseAnnotation(annotationMatch[1]) : null;

    let param: ScadParameter;
    if (literal.type === "boolean") {
      param = { name, type: "boolean", default: literal.value, description };
    } else if (literal.type === "number") {
      param = { name, type: "number", default: literal.value, description };
      if (annotation?.kind === "range") {
        param.min = annotation.min;
        param.max = annotation.max;
        if (annotation.step !== undefined) param.step = annotation.step;
      } else if (annotation?.kind === "maxOnly") {
        param.min = 0;
        param.max = annotation.max;
      } else if (annotation?.kind === "maxLength") {
        // bare number on a numeric param = spin-box step
        param.step = annotation.maxLength;
      } else if (annotation?.kind === "options") {
        const numeric = annotation.options.map((o) => ({
          value: Number(o.value),
          label: o.label,
        }));
        if (numeric.every((o) => Number.isFinite(o.value))) param.options = numeric;
      }
    } else if (literal.type === "string") {
      param = { name, type: "string", default: literal.value, description };
      if (annotation?.kind === "options") param.options = annotation.options;
      else if (annotation?.kind === "maxLength")
        param.maxLength = Math.min(annotation.maxLength, STRING_MAX_LENGTH);
    } else {
      param = { name, type: "vector", default: literal.value, description };
      if (annotation?.kind === "range") {
        param.min = annotation.min;
        param.max = annotation.max;
        if (annotation.step !== undefined) param.step = annotation.step;
      } else if (annotation?.kind === "maxOnly") {
        param.min = 0;
        param.max = annotation.max;
      }
    }

    current.parameters.push(param);
    total += 1;
  }

  pushGroup();
  return groups;
}

// --- value coercion ---------------------------------------------------------

function clamp(value: number, min: number | undefined, max: number | undefined): number {
  let v = value;
  if (min !== undefined && v < min) v = min;
  if (max !== undefined && v > max) v = max;
  return v;
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : "0";
}

// Validates client-submitted values against the parsed schema and returns the
// canonical {name: stringValue} map for OpenSCAD's parameter-set JSON (which
// stringifies every value). Unknown names are dropped, numbers clamped to the
// annotated range, dropdowns must match an option, strings are length-capped,
// vectors must match the default's length. Values never reach a command line
// (the service passes them via -p JSON only), but the tight canonicalization
// here is defense in depth.
export function coerceScadValues(
  groups: ScadParameterGroup[],
  values: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const group of groups) {
    for (const param of group.parameters) {
      const raw = values[param.name];
      if (raw === undefined || raw === null) continue;

      if (param.type === "boolean") {
        if (typeof raw !== "boolean" && raw !== "true" && raw !== "false") continue;
        const v = typeof raw === "boolean" ? raw : raw === "true";
        if (v !== param.default) out[param.name] = String(v);
      } else if (param.type === "number") {
        const n = typeof raw === "number" ? raw : Number(String(raw).trim());
        if (!Number.isFinite(n)) continue;
        let v = n;
        if (param.options) {
          if (!param.options.some((o) => o.value === n)) continue;
        } else {
          v = clamp(n, param.min, param.max);
        }
        if (v !== param.default) out[param.name] = formatNumber(v);
      } else if (param.type === "string") {
        if (typeof raw !== "string") continue;
        let v = raw.slice(0, param.maxLength ?? STRING_MAX_LENGTH);
        if (param.options && !param.options.some((o) => o.value === v)) continue;
        // strip quotes/backslashes so the value can't escape OpenSCAD's own
        // string literal when the parameter set is applied
        v = v.replace(/["\\]/g, "");
        if (v !== param.default) out[param.name] = v;
      } else {
        // vector: accept an array of numbers with the same length as default
        if (!Array.isArray(raw) || raw.length !== param.default.length) continue;
        const nums = raw.map((x) => (typeof x === "number" ? x : Number(String(x).trim())));
        if (nums.some((n) => !Number.isFinite(n))) continue;
        const clamped = nums.map((n) => clamp(n, param.min, param.max));
        if (JSON.stringify(clamped) !== JSON.stringify(param.default)) {
          out[param.name] = `[${clamped.map(formatNumber).join(",")}]`;
        }
      }

      if (out[param.name] !== undefined && out[param.name].length > VALUE_MAX_LENGTH) {
        delete out[param.name];
      }
    }
  }
  return out;
}

// --- include scanning -------------------------------------------------------

// Libraries bundled in the openscad service image (see openscad/Dockerfile).
// Only includes that resolve inside these directories are allowed.
export const SCAD_LIBRARY_ALLOWLIST = ["BOSL2/", "MCAD/"];

// Scans include<>/use<> directives and import()/surface() calls. The renderer
// runs in an empty temp dir, so a stray path mostly just fails — but rejecting
// up front gives the uploader a clear message and keeps /etc-style probes out
// of the service entirely. Multi-file projects (sibling includes) are
// unsupported in v1: only bundled-library includes pass.
export function findForbiddenFileRefs(source: string): string[] {
  const violations: string[] = [];
  const seen = new Set<string>();

  const flag = (target: string, why: string) => {
    const key = `${target}|${why}`;
    if (!seen.has(key)) {
      seen.add(key);
      violations.push(`${why}: ${target}`);
    }
  };

  const allowed = (target: string) =>
    SCAD_LIBRARY_ALLOWLIST.some((prefix) => target.startsWith(prefix));

  // include <path> / use <path> — angle-bracket targets are not string
  // literals, so they survive comment/string blanking and can be read
  // straight from the blanked code (occurrences inside comments are blanked
  // away and correctly skipped).
  const code = blankNonCode(source);
  const directive = /\b(include|use)\s*<([^>\n]*)>/g;
  let match: RegExpExecArray | null;
  while ((match = directive.exec(code)) !== null) {
    const target = match[2].trim();
    if (target.startsWith("/") || /^[a-zA-Z]:/.test(target) || target.includes("..")) {
      flag(target, `${match[1]} escapes the allowed libraries`);
    } else if (!allowed(target)) {
      flag(target, `${match[1]} of a file that is not part of the bundled libraries`);
    }
  }

  // import()/surface() read external files at render time. There is no file
  // the source could legitimately reference — uploads are single .scad files
  // and the renderer's temp dir is empty — so any call is a violation, no
  // matter how the path is built.
  const call = /\b(import|surface)\s*\(/g;
  while ((match = call.exec(code)) !== null) {
    flag(match[1], `${match[1]}() reads external files`);
  }

  return violations;
}
