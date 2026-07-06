import { test } from "node:test";
import assert from "node:assert/strict";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { normalizeModelXml, normalizeThreeMf } from "@/lib/threemf-normalize";

// A 10×10×10 (in the given unit) cube centered on the XY origin, like
// Onshape exports it.
function modelXml({
  unit,
  size = 10,
  itemAttrs = "",
}: {
  unit: string;
  size?: number;
  itemAttrs?: string;
}): string {
  const h = size / 2;
  const v = (x: number, y: number, z: number) => `<vertex x="${x}" y="${y}" z="${z}" />`;
  return `<?xml version="1.0" encoding="utf-8"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" unit="${unit}" xml:lang="en-US">
\t<resources>
\t\t<object id="2" name="Part 1" type="model">
\t\t\t<mesh>
\t\t\t\t<vertices>
\t\t\t\t\t${v(-h, -h, 0)}${v(h, -h, 0)}${v(h, h, 0)}${v(-h, h, 0)}
\t\t\t\t\t${v(-h, -h, size)}${v(h, -h, size)}${v(h, h, size)}${v(-h, h, size)}
\t\t\t\t</vertices>
\t\t\t\t<triangles><triangle v1="0" v2="1" v3="2" /></triangles>
\t\t\t</mesh>
\t\t</object>
\t</resources>
\t<build>
\t\t<item objectid="2"${itemAttrs}/>
\t</build>
</model>`;
}

function archive(xml: string): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "_rels/.rels": strToU8("<Relationships/>"),
    "3D/3dmodel.model": strToU8(xml),
  });
}

function itemTransform(xml: string): number[] {
  const attr = xml.match(/<item\b[^>]*\btransform="([^"]+)"/)?.[1];
  assert.ok(attr, "build item should carry a transform");
  return attr.split(/\s+/).map(Number);
}

test("normalizeModelXml scales a meter model to millimeters", () => {
  // 0.01 m cube = the 10 mm cube Onshape would write for a meter-unit export.
  const out = normalizeModelXml(modelXml({ unit: "meter", size: 0.01 }));
  assert.ok(out);
  assert.match(out, /<model\b[^>]*\bunit="millimeter"/);
  assert.match(out, /<vertex x="-5" y="-5" z="0"/);
  assert.match(out, /<vertex x="5" y="5" z="10"/);
  // The build gets moved so the cube is centered at (128,128) with z ≥ 0.
  const t = itemTransform(out);
  assert.deepEqual(t.slice(9), [128, 128, 0]);
});

test("normalizeModelXml scales transform translations but not the linear part", () => {
  // Item shifted 0.1 m up: rotation/scale block stays, translation ×1000.
  const out = normalizeModelXml(
    modelXml({
      unit: "meter",
      size: 0.01,
      itemAttrs: ' transform="1 0 0 0 1 0 0 0 1 0 0 0.1"',
    }),
  );
  assert.ok(out);
  const t = itemTransform(out);
  assert.deepEqual(t.slice(0, 9), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  // z translation: 0.1 m -> 100 mm, then dropped onto the plate (z min was
  // already 0 + 100, so the delta puts it back at 0 -> net 0).
  assert.deepEqual(t.slice(9), [128, 128, 0]);
});

test("normalizeModelXml recenters origin-straddling millimeter models", () => {
  const out = normalizeModelXml(modelXml({ unit: "millimeter" }));
  assert.ok(out);
  // Geometry untouched, placement via the item transform only.
  assert.match(out, /<vertex x="-5" y="-5" z="0"/);
  assert.deepEqual(itemTransform(out).slice(9), [128, 128, 0]);
});

test("normalizeModelXml leaves an already normalized model alone", () => {
  const xml = modelXml({
    unit: "millimeter",
    itemAttrs: ' transform="1 0 0 0 1 0 0 0 1 128 128 0"',
  });
  assert.equal(normalizeModelXml(xml), null);
});

test("normalizeThreeMf rewrites the archive and keeps other entries", () => {
  const out = normalizeThreeMf(archive(modelXml({ unit: "meter", size: 0.01 })));
  const entries = unzipSync(out);
  assert.deepEqual(Object.keys(entries).sort(), [
    "3D/3dmodel.model",
    "[Content_Types].xml",
    "_rels/.rels",
  ]);
  assert.match(strFromU8(entries["3D/3dmodel.model"]), /unit="millimeter"/);
});

test("normalizeThreeMf returns non-3MF input unchanged", () => {
  const garbage = strToU8("not a zip at all");
  assert.equal(normalizeThreeMf(garbage), garbage);
});
