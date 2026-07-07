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
    "Metadata/Slic3r_PE.config": strToU8(
      "printer_model = MK4S\nnozzle_diameter = 0.4\nfilament_type = PLA;PLA\n",
    ),
  });
  const { readRange, size } = readerFor(zip);
  const data = await readSliceData(readRange, size);
  assert.equal(data?.sliceInfo, null);
  assert.deepEqual(data?.printerInfo, {
    model: "MK4S",
    nozzleDiameterMm: 0.4,
    filamentTypes: ["PLA"],
  });
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
