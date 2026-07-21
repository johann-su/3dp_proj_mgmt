import { test } from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { readSliceData, type RangeReader } from "@/lib/threemf-slice-info";

// Serves an in-memory archive the way S3 serves ranged GETs (inclusive end,
// clamped to the object size).
function readerFor(bytes: Uint8Array): { readRange: RangeReader; size: number } {
  return {
    size: bytes.length,
    readRange: async (start, end) =>
      bytes.subarray(start, Math.min(end + 1, bytes.length)),
  };
}

const SLICE_INFO = `<config>
  <plate>
    <metadata key="prediction" value="3600"/>
    <metadata key="weight" value="12.5"/>
  </plate>
  <plate>
    <metadata key="prediction" value="1800"/>
    <metadata key="weight" value="7.5"/>
  </plate>
</config>`;

test("readSliceData sums predictions and weights across plates (sliced Bambu file)", async () => {
  const zip = zipSync({
    "3D/3dmodel.model": strToU8("<model/>"),
    "Metadata/slice_info.config": strToU8(SLICE_INFO),
    // Objects assigned to extruder 2 → only the second filament counts.
    "Metadata/model_settings.config": strToU8(
      `<config><object><metadata key="extruder" value="2"/></object></config>`,
    ),
    "Metadata/project_settings.config": strToU8(
      JSON.stringify({
        printer_model: "Bambu Lab P1S",
        nozzle_diameter: ["0.4"],
        curr_bed_type: "Textured PEI Plate",
        filament_type: ["PLA", "PETG"],
        // Bed polygon → 256×256 plate. bed_exclude_area (the Bambu logo corner)
        // is not part of the plate size and must be ignored.
        printable_area: ["0x0", "256x0", "256x256", "0x256"],
        bed_exclude_area: ["0x0", "18x0", "18x28", "0x28"],
      }),
    ),
  });
  const { readRange, size } = readerFor(zip);
  const data = await readSliceData(readRange, size);
  assert.deepEqual(data?.sliceInfo, {
    plateCount: 2,
    printTimeSeconds: 5400,
    filamentGrams: 20,
  });
  assert.deepEqual(data?.printerInfo, {
    model: "Bambu Lab P1S",
    nozzleDiameterMm: 0.4,
    bedType: "Textured PEI Plate",
    filamentTypes: ["PETG"],
    bedSizeMm: { x: 256, y: 256 },
  });
});

test("readSliceData counts plates from model_settings for unsliced projects", async () => {
  const zip = zipSync({
    "Metadata/model_settings.config": strToU8("<config><plate></plate></config>"),
  });
  const { readRange, size } = readerFor(zip);
  const data = await readSliceData(readRange, size);
  assert.deepEqual(data?.sliceInfo, {
    plateCount: 1,
    printTimeSeconds: null,
    filamentGrams: null,
  });
});

test("readSliceData reads printer info from a PrusaSlicer project ini", async () => {
  const zip = zipSync({
    // bed_shape is a comma-joined "XxY" polygon → a rectangular 250×210 plate.
    "Metadata/Slic3r_PE.config": strToU8(
      "printer_model = MK4S\nnozzle_diameter = 0.4\nfilament_type = PLA;PLA\n" +
        "bed_shape = 0x0,250x0,250x210,0x210\n",
    ),
  });
  const { readRange, size } = readerFor(zip);
  const data = await readSliceData(readRange, size);
  assert.equal(data?.sliceInfo, null);
  assert.deepEqual(data?.printerInfo, {
    model: "MK4S",
    nozzleDiameterMm: 0.4,
    filamentTypes: ["PLA"],
    bedSizeMm: { x: 250, y: 210 },
  });
});

// When the embedded config carries no usable bed shape but names a recognizable
// printer, the bed size falls back to a known-model lookup (issue #80). Here an
// A1 mini must resolve to its 180×180 plate, not the wider 256 A1 rule.
test("readSliceData falls back to a known-model bed size when no shape is present", async () => {
  const zip = zipSync({
    "Metadata/project_settings.config": strToU8(
      JSON.stringify({ printer_model: "Bambu Lab A1 mini" }),
    ),
  });
  const { readRange, size } = readerFor(zip);
  const data = await readSliceData(readRange, size);
  assert.deepEqual(data?.printerInfo?.bedSizeMm, { x: 180, y: 180 });
});

// A malformed bed polygon must not yield a bogus size; parsing rejects it and,
// with no recognizable model, no bed size is reported at all.
test("readSliceData omits bed size for a malformed bed shape", async () => {
  const zip = zipSync({
    "Metadata/project_settings.config": strToU8(
      JSON.stringify({
        printer_model: "Some Random Printer",
        printable_area: ["0x0", "256x0", "garbage"],
      }),
    ),
  });
  const { readRange, size } = readerFor(zip);
  const data = await readSliceData(readRange, size);
  assert.equal(data?.printerInfo?.bedSizeMm, undefined);
});

test("readSliceData returns null for archives without slicer metadata", async () => {
  const zip = zipSync({ "3D/3dmodel.model": strToU8("<model/>") });
  const { readRange, size } = readerFor(zip);
  assert.equal(await readSliceData(readRange, size), null);
});

test("readSliceData returns null for non-ZIP input", async () => {
  const { readRange, size } = readerFor(strToU8("not a zip archive"));
  assert.equal(await readSliceData(readRange, size), null);
});
