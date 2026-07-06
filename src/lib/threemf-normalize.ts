// Normalizes a 3MF archive for slicing: converts the model to millimeters and
// moves the build onto the positive plate area.
//
// Both steps exist because of Onshape exports: Onshape writes 3MF in meters
// (regardless of the `unit` translation parameter) with parts modeled around
// the coordinate origin. That file is spec-valid, but PrusaSlicer, Bambu
// Studio and OrcaSlicer all ignore the 3MF `unit` attribute and read
// coordinates as millimeters (a 25 mm part becomes 0.025 mm), and they reject
// geometry at negative X/Y as "outside of the print volume". Normalizing at
// import fixes the stored file for the estimate slicer *and* for users who
// download it into their own slicer.
//
// Uses fflate only (no load-time side effects) so it stays unit-testable.

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

// 3MF core spec §3.4: allowed values of the <model> unit attribute.
const UNIT_TO_MM: Record<string, number> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

// Where to put the XY center of the build: middle of a 256 mm plate — dead
// center for Bambu-size beds and still well inside smaller ones. The estimate
// slicer's virtual bed is far larger, so the exact value only affects how the
// file looks when opened in a desktop slicer.
const TARGET_CENTER_MM = 128;

// A 3MF transform is 12 numbers (4×3 row-major); rows 0–2 are the linear part
// and row 3 (indices 9–11) is the translation. Points are row vectors:
// p' = p·M + t.
type Mat = number[];

const IDENTITY: Mat = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

function applyMat(m: Mat, x: number, y: number, z: number): [number, number, number] {
  return [
    x * m[0] + y * m[3] + z * m[6] + m[9],
    x * m[1] + y * m[4] + z * m[7] + m[10],
    x * m[2] + y * m[5] + z * m[8] + m[11],
  ];
}

// compose(a, b) = "apply a, then b" (child transform first, parent second).
function composeMat(a: Mat, b: Mat): Mat {
  const out: Mat = new Array(12).fill(0);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      out[row * 3 + col] =
        a[row * 3] * b[col] + a[row * 3 + 1] * b[3 + col] + a[row * 3 + 2] * b[6 + col];
    }
  }
  const t = applyMat(b, a[9], a[10], a[11]);
  [out[9], out[10], out[11]] = t;
  return out;
}

function parseMat(attr: string): Mat | null {
  const nums = attr.trim().split(/\s+/).map(Number);
  return nums.length === 12 && nums.every(Number.isFinite) ? nums : null;
}

// XML attribute values must not use scientific notation some consumers choke
// on; fixed decimals trimmed of trailing zeros are safe everywhere.
function fmt(value: number): string {
  const s = value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return s === "" || s === "-" || s === "-0" ? "0" : s;
}

type Box = { min: [number, number, number]; max: [number, number, number] };

function emptyBox(): Box {
  return {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
}

function extendBox(box: Box, p: [number, number, number]) {
  for (let i = 0; i < 3; i++) {
    if (p[i] < box.min[i]) box.min[i] = p[i];
    if (p[i] > box.max[i]) box.max[i] = p[i];
  }
}

function boxIsEmpty(box: Box): boolean {
  return box.min[0] > box.max[0];
}

type ParsedObject = {
  // Local bounding box of the object's own mesh, if it has one.
  meshBox: Box | null;
  components: { objectId: string; transform: Mat }[];
};

function parseObjects(xml: string): Map<string, ParsedObject> {
  const objects = new Map<string, ParsedObject>();
  for (const m of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const id = m[1].match(/\bid="([^"]+)"/)?.[1];
    if (!id) continue;
    const body = m[2];
    let meshBox: Box | null = null;
    for (const v of body.matchAll(/<vertex\b([^>]*?)\/?>/g)) {
      const x = v[1].match(/\bx="([^"]+)"/)?.[1];
      const y = v[1].match(/\by="([^"]+)"/)?.[1];
      const z = v[1].match(/\bz="([^"]+)"/)?.[1];
      if (x === undefined || y === undefined || z === undefined) continue;
      meshBox ??= emptyBox();
      extendBox(meshBox, [Number(x), Number(y), Number(z)]);
    }
    const components: ParsedObject["components"] = [];
    for (const c of body.matchAll(/<component\b([^>]*?)\/?>/g)) {
      const objectId = c[1].match(/\bobjectid="([^"]+)"/)?.[1];
      if (!objectId) continue;
      const transform = c[1].match(/\btransform="([^"]+)"/)?.[1];
      components.push({
        objectId,
        transform: (transform && parseMat(transform)) || IDENTITY,
      });
    }
    objects.set(id, { meshBox, components });
  }
  return objects;
}

// Bounding box of one object under `matrix`, following component references.
// Transforming the 8 corners of a mesh's local box yields a valid (possibly
// loose) bound because affine maps preserve convexity.
function objectBox(
  objects: Map<string, ParsedObject>,
  id: string,
  matrix: Mat,
  into: Box,
  depth = 0,
) {
  const object = objects.get(id);
  if (!object || depth > 8) return;
  if (object.meshBox && !boxIsEmpty(object.meshBox)) {
    const { min, max } = object.meshBox;
    for (const x of [min[0], max[0]])
      for (const y of [min[1], max[1]])
        for (const z of [min[2], max[2]]) extendBox(into, applyMat(matrix, x, y, z));
  }
  for (const c of object.components) {
    objectBox(objects, c.objectId, composeMat(c.transform, matrix), into, depth + 1);
  }
}

function scaleTransformAttr(attr: string, scale: number): string {
  const mat = parseMat(attr);
  if (!mat) return attr;
  mat[9] *= scale;
  mat[10] *= scale;
  mat[11] *= scale;
  return mat.map(fmt).join(" ");
}

// Rewrites the model XML: scales to millimeters and translates the build so
// its XY center sits at TARGET_CENTER_MM and its lowest point at z=0.
// Exported for tests; use normalizeThreeMf for archives.
export function normalizeModelXml(xml: string): string | null {
  const unit = xml.match(/<model\b[^>]*?\bunit="([^"]+)"/)?.[1] ?? "millimeter";
  const scale = UNIT_TO_MM[unit] ?? 1;

  let out = xml;
  if (scale !== 1) {
    out = out.replace(
      /(<model\b[^>]*?\bunit=")[^"]+(")/,
      (_, pre, post) => `${pre}millimeter${post}`,
    );
    out = out.replace(/<vertex\b[^>]*?\/?>/g, (tag) =>
      tag.replace(
        /\b([xyz])="([^"]+)"/g,
        (_, axis, value) => `${axis}="${fmt(Number(value) * scale)}"`,
      ),
    );
    // Translation parts of every transform are lengths too (the linear 3×3
    // part is unitless and stays).
    out = out.replace(
      /\btransform="([^"]+)"/g,
      (_, attr) => `transform="${scaleTransformAttr(attr, scale)}"`,
    );
  }

  // Compute the build's bounding box from the (now millimeter) geometry.
  const objects = parseObjects(out);
  const box = emptyBox();
  const items = [...out.matchAll(/<item\b([^>]*?)\/?>/g)];
  for (const item of items) {
    const objectId = item[1].match(/\bobjectid="([^"]+)"/)?.[1];
    if (!objectId) continue;
    const transform = item[1].match(/\btransform="([^"]+)"/)?.[1];
    objectBox(objects, objectId, (transform && parseMat(transform)) || IDENTITY, box);
  }
  if (boxIsEmpty(box)) return scale !== 1 ? out : null;

  const delta: [number, number, number] = [
    TARGET_CENTER_MM - (box.min[0] + box.max[0]) / 2,
    TARGET_CENTER_MM - (box.min[1] + box.max[1]) / 2,
    -box.min[2],
  ];
  if (scale === 1 && delta.every((d) => Math.abs(d) < 1e-6)) return null;

  // Move every build item by the same delta so relative placement survives.
  out = out.replace(/<item\b[^>]*?\/?>/g, (tag) => {
    if (!/\bobjectid="/.test(tag)) return tag;
    const existing = tag.match(/\btransform="([^"]+)"/)?.[1];
    const mat = (existing && parseMat(existing)) || IDENTITY.slice();
    mat[9] += delta[0];
    mat[10] += delta[1];
    mat[11] += delta[2];
    const attr = `transform="${mat.map(fmt).join(" ")}"`;
    return existing !== undefined && parseMat(existing)
      ? tag.replace(/\btransform="[^"]+"/, attr)
      : tag.replace(/(\/?>)$/, ` ${attr}$1`);
  });
  return out;
}

// Returns a normalized copy of the archive, or the input unchanged when the
// file already is in millimeters and placed, or when it cannot be parsed
// (a broken archive should surface downstream, not here).
export function normalizeThreeMf(data: Uint8Array): Uint8Array {
  try {
    const entries = unzipSync(data);
    const modelPath = Object.keys(entries).find((name) => name.endsWith(".model"));
    if (!modelPath) return data;
    const rewritten = normalizeModelXml(strFromU8(entries[modelPath]));
    if (rewritten === null) return data;
    entries[modelPath] = strToU8(rewritten);
    return zipSync(entries);
  } catch {
    return data;
  }
}
