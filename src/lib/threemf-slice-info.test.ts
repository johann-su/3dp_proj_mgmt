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
        enable_support: "1",
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
    filamentColors: undefined,
    // One nozzle on the machine → the AMS swap can't need a second one.
    requiresMultiNozzle: false,
    usesSupport: true,
    bedSizeMm: { x: 256, y: 256 },
  });
});

// "Does it need supports?" is answerable from the embedded config, but only
// when it says so: a missing key must stay undefined ("unknown") rather than
// collapsing to false, which would read as "no supports needed".
test("readSliceData reports the support setting only when the config states it", async () => {
  const withoutSupportKey = zipSync({
    "Metadata/project_settings.config": strToU8(
      JSON.stringify({ printer_model: "Bambu Lab P1S" }),
    ),
  });
  const off = zipSync({
    "Metadata/Slic3r_PE.config": strToU8(
      "printer_model = MK4S\nsupport_material = 0\n",
    ),
  });

  const a = readerFor(withoutSupportKey);
  assert.equal(
    (await readSliceData(a.readRange, a.size))?.printerInfo?.usesSupport,
    undefined,
  );
  const b = readerFor(off);
  assert.equal(
    (await readSliceData(b.readRange, b.size))?.printerInfo?.usesSupport,
    false,
  );
});

// The AMS case: two slots of the *same* material is still a two-colour print,
// so the slots must survive as separate entries (a deduped ["PLA"] would read
// as single-colour) — and one nozzle on the machine means one nozzle needed.
test("readSliceData keeps one filament entry per used slot, with colours", async () => {
  const zip = zipSync({
    "Metadata/model_settings.config": strToU8(
      `<config><object><metadata key="extruder" value="1"/>` +
        `<part><metadata key="extruder" value="2"/></part></object></config>`,
    ),
    "Metadata/project_settings.config": strToU8(
      JSON.stringify({
        printer_model: "Bambu Lab P1S",
        nozzle_diameter: ["0.4"],
        filament_type: ["PLA", "PLA", "PETG"],
        // Slot 2 carries Bambu's optional alpha pair; slot 3 is parked in the
        // AMS but unused, so its colour must not show up.
        filament_colour: ["#FF0000", "#000000FF", "#00FF00"],
      }),
    ),
  });
  const { readRange, size } = readerFor(zip);
  const info = (await readSliceData(readRange, size))?.printerInfo;
  assert.deepEqual(info?.filamentTypes, ["PLA", "PLA"]);
  assert.deepEqual(info?.filamentColors, ["#ff0000", "#000000"]);
  assert.equal(info?.requiresMultiNozzle, false);
});

// Colours are index-parallel to the types by contract, so a slot the config
// never coloured drops the array rather than shifting every later swatch.
test("readSliceData omits filament colours unless every used slot has one", async () => {
  const zip = zipSync({
    "Metadata/model_settings.config": strToU8(
      `<config><object><metadata key="extruder" value="1"/>` +
        `<part><metadata key="extruder" value="2"/></part></object></config>`,
    ),
    "Metadata/project_settings.config": strToU8(
      JSON.stringify({
        filament_type: ["PLA", "PETG"],
        filament_colour: ["#FF0000", ""],
      }),
    ),
  });
  const { readRange, size } = readerFor(zip);
  const info = (await readSliceData(readRange, size))?.printerInfo;
  assert.deepEqual(info?.filamentTypes, ["PLA", "PETG"]);
  assert.equal(info?.filamentColors, undefined);
});

// Multi-*colour* and multi-*nozzle* are different questions: an AMS feeds many
// slots through one nozzle. Only slots mapped to different physical extruders
// (filament_map, written by dual-nozzle machines like the H2D) need the
// hardware — and nozzle_diameter then has one entry per extruder, so the
// reported nozzle is the one the objects actually print from.
test("readSliceData flags multi-nozzle only when slots span physical extruders", async () => {
  const dualNozzle = (usedExtruders: number[]) =>
    zipSync({
      "Metadata/model_settings.config": strToU8(
        `<config>${usedExtruders
          .map((e) => `<object><metadata key="extruder" value="${e}"/></object>`)
          .join("")}</config>`,
      ),
      "Metadata/project_settings.config": strToU8(
        JSON.stringify({
          printer_model: "Bambu Lab H2D",
          nozzle_diameter: ["0.4", "0.6"],
          filament_type: ["PLA", "PETG", "ABS"],
          // Slots 1+2 hang off the left nozzle, slot 3 off the right one.
          filament_map: ["1", "1", "2"],
        }),
      ),
    });

  const both = readerFor(dualNozzle([1, 3]));
  const spanning = (await readSliceData(both.readRange, both.size))?.printerInfo;
  assert.deepEqual(spanning?.filamentTypes, ["PLA", "ABS"]);
  assert.equal(spanning?.requiresMultiNozzle, true);
  assert.equal(spanning?.nozzleDiameterMm, 0.4);

  // Two slots, one nozzle: a filament swap on the same extruder.
  const oneSide = readerFor(dualNozzle([1, 2]));
  const shared = (await readSliceData(oneSide.readRange, oneSide.size))?.printerInfo;
  assert.equal(shared?.requiresMultiNozzle, false);

  // Everything on the second extruder → its 0.6 nozzle, not the machine's first.
  const right = readerFor(dualNozzle([3]));
  const single = (await readSliceData(right.readRange, right.size))?.printerInfo;
  assert.equal(single?.requiresMultiNozzle, false);
  assert.equal(single?.nozzleDiameterMm, 0.6);
});

// PrusaSlicer states the distinction outright: single_extruder_multi_material
// is an MMU multiplexing colours through one nozzle, while the same multi-slot
// print without it is a toolchanger (XL). Its per-object extruders live in its
// own model config — without honouring it, an MMU/XL profile's five parked
// filament slots would all count as used.
test("readSliceData tells a Prusa MMU apart from a toolchanger", async () => {
  const prusa = (semm: string) =>
    zipSync({
      "Metadata/Slic3r_PE_model.config": strToU8(
        `<config><object id="1"><metadata type="object" key="extruder" value="1"/>` +
          // value="0" means "inherit the object's extruder" — not a slot.
          `<volume><metadata type="volume" key="extruder" value="0"/></volume>` +
          `</object><object id="2">` +
          `<metadata type="object" key="extruder" value="3"/></object></config>`,
      ),
      "Metadata/Slic3r_PE.config": strToU8(
        "printer_model = XL\nnozzle_diameter = 0.4,0.4,0.4,0.4,0.4\n" +
          "filament_type = PLA;PETG;PLA;PLA;PLA\n" +
          "filament_colour = #FF8000;#0000FF;#101010;#FFFFFF;#FFFFFF\n" +
          `single_extruder_multi_material = ${semm}\n`,
      ),
    });

  const mmu = readerFor(prusa("1"));
  const multiplexed = (await readSliceData(mmu.readRange, mmu.size))?.printerInfo;
  // Slots 2/4/5 are configured but unused; slots 1 and 3 are both PLA.
  assert.deepEqual(multiplexed?.filamentTypes, ["PLA", "PLA"]);
  assert.deepEqual(multiplexed?.filamentColors, ["#ff8000", "#101010"]);
  assert.equal(multiplexed?.requiresMultiNozzle, false);

  const xl = readerFor(prusa("0"));
  const toolchanger = (await readSliceData(xl.readRange, xl.size))?.printerInfo;
  assert.equal(toolchanger?.requiresMultiNozzle, true);
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
    filamentColors: undefined,
    requiresMultiNozzle: false,
    usesSupport: undefined,
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
