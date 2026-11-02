import { test } from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import type { RangeReader } from "@/lib/threemf-slice-info";
import {
  describeScanRulerProject,
  readScanRulerProjectSummary,
  summarizeScanRulerManifest,
} from "@/lib/scanruler-project";

function readerFor(bytes: Uint8Array): { readRange: RangeReader; size: number } {
  return {
    readRange: async (start, end) => bytes.slice(start, end + 1),
    size: bytes.length,
  };
}

// The shape ScanRuler 0.9 writes (schemaVersion 1), trimmed to what we read.
const MANIFEST = {
  app: "ScanRuler",
  schemaVersion: 1,
  appVersion: "0.9.2",
  name: "Bracket",
  workspace: "reverse",
  scan: { fileName: "bracket.stl", member: "scan.stl", elements: [{}, {}, {}], dimensions: [{}] },
  deviation: {},
  thickness: {},
  flat: {},
  reverse: { features: [{}, {}] },
};

test("reads project.json out of a .scanruler archive by ranged reads", async () => {
  // The scan member is stored uncompressed and large; only the manifest is read.
  const zip = zipSync({
    "scan.stl": [new Uint8Array(512 * 1024), { level: 0 }],
    "project.json": strToU8(JSON.stringify(MANIFEST)),
  });
  let bytesRead = 0;
  const { readRange, size } = readerFor(zip);
  const summary = await readScanRulerProjectSummary(async (s, e) => {
    bytesRead += e - s + 1;
    return readRange(s, e);
  }, size);
  assert.deepEqual(summary, {
    name: "Bracket",
    appVersion: "0.9.2",
    workspace: "reverse",
    scanFile: "bracket.stl",
    elements: 3,
    dimensions: 1,
    features: 2,
  });
  assert.ok(bytesRead < 128 * 1024, `read ${bytesRead} bytes of ${size}`);
});

test("a blank project (no scan, no plugins) still summarizes", () => {
  // ScanRuler can model without a scan: `scan: null`, no reverse section.
  const summary = summarizeScanRulerManifest({ ...MANIFEST, scan: null, reverse: undefined, name: undefined });
  assert.equal(summary?.scanFile, null);
  assert.equal(summary?.features, 0);
  assert.equal(summary?.name, null);
});

test("anything that isn't a ScanRuler manifest is rejected", async () => {
  assert.equal(summarizeScanRulerManifest({ ...MANIFEST, app: "Other" }), null);
  assert.equal(summarizeScanRulerManifest({ app: "ScanRuler" }), null);
  assert.equal(summarizeScanRulerManifest([1, 2]), null);
  // Not JSON, no manifest, not a ZIP at all.
  const junk = zipSync({ "project.json": strToU8("{oops") });
  assert.equal(await readScanRulerProjectSummary(readerFor(junk).readRange, junk.length), null);
  const other = zipSync({ "readme.txt": strToU8("hi") });
  assert.equal(await readScanRulerProjectSummary(readerFor(other).readRange, other.length), null);
  const notZip = strToU8("plain text, no central directory");
  assert.equal(await readScanRulerProjectSummary(readerFor(notZip).readRange, notZip.length), null);
});

test("describeScanRulerProject lists only what the project holds", () => {
  const summary = summarizeScanRulerManifest(MANIFEST)!;
  assert.equal(describeScanRulerProject(summary), "bracket.stl · 3 elements · 1 dimension · 2 features");
  assert.equal(
    describeScanRulerProject({ ...summary, scanFile: null, elements: 0, dimensions: 0, features: 1 }),
    "1 feature",
  );
});

test("an unreadable project describes as empty, not as an error", () => {
  assert.equal(describeScanRulerProject(null), "");
});
