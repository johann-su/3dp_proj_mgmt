import { test } from "node:test";
import assert from "node:assert/strict";
import {
  flattenPreset,
  genericPresetSet,
  parseResultJson,
  parseSliceInfo,
  platesToSlice,
  projectPlates,
  prusaIniToOrca,
  stripPostProcess,
  toCliFlags,
  usedExtruder,
} from "./lib.mjs";

// Shape of the slice_info.config OrcaSlicer 2.4 writes into a sliced 3mf.
const plate = ({ prediction, weight, filaments }) => `
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="prediction" value="${prediction}"/>
    <metadata key="weight" value="${weight}"/>
    <metadata key="first_layer_time" value="18064505105261496075701714944.000000"/>
    ${filaments
      .map(
        ([m, g]) =>
          `<filament id="1" type="PLA" color="#000000" used_m="${m}" used_g="${g}" used_for_object="true"/>`,
      )
      .join("\n")}
  </plate>`;

test("parseSliceInfo sums prediction, weight and filament length over plates", () => {
  const xml = `<config>${plate({ prediction: 24157, weight: "202.21", filaments: [["67.80", "202.21"]] })}${plate({ prediction: 6226, weight: "58.06", filaments: [["15", "40"], ["5.5", "18.06"]] })}</config>`;
  assert.deepEqual(parseSliceInfo(xml), {
    plates: 2,
    printTimeSeconds: 30383,
    filamentGrams: 260.27,
    filamentMm: 88300, // metres -> mm, summed over every filament
  });
});

test("parseSliceInfo falls back to per-filament grams when weight is empty", () => {
  // A filament preset without density leaves `weight` empty.
  const xml = plate({ prediction: 100, weight: "", filaments: [["1", "2.5"], ["1", "0.5"]] });
  assert.equal(parseSliceInfo(xml).filamentGrams, 3);
});

test("parseSliceInfo reports no print time when nothing was sliced", () => {
  assert.deepEqual(parseSliceInfo("<config></config>"), {
    plates: 0,
    printTimeSeconds: null,
    filamentGrams: null,
    filamentMm: null,
  });
});

test("parseResultJson reads the CLI's status, tolerating junk", () => {
  assert.deepEqual(
    parseResultJson(
      '{"error_string": "One of the plate is empty", "plate_index": 2, "return_code": -50}',
    ),
    { returnCode: -50, error: "One of the plate is empty", plateIndex: 2 },
  );
  assert.equal(parseResultJson("not json"), null);
  assert.equal(parseResultJson("{}"), null); // no return_code: not a result file
});

test("projectPlates counts instances per plate; empty plates are sliced around", () => {
  const xml = `<config>
    <object id="2"><metadata key="name" value="a"/></object>
    <plate>
      <metadata key="plater_id" value="1"/>
      <model_instance><metadata key="object_id" value="2"/></model_instance>
      <model_instance><metadata key="object_id" value="3"/></model_instance>
    </plate>
    <plate><metadata key="plater_id" value="2"/></plate>
    <plate>
      <metadata key="plater_id" value="3"/>
      <model_instance><metadata key="object_id" value="4"/></model_instance>
    </plate>
  </config>`;
  const plates = projectPlates(xml);
  assert.deepEqual(plates, [
    { index: 1, instances: 2 },
    { index: 2, instances: 0 },
    { index: 3, instances: 1 },
  ]);
  // An empty plate aborts `--slice 0`, so slice the others one by one.
  assert.deepEqual(platesToSlice(plates), [1, 3]);
  // No empty plate: a single run over all plates.
  assert.deepEqual(platesToSlice([{ index: 1, instances: 1 }, { index: 2, instances: 4 }]), [0]);
  assert.deepEqual(platesToSlice([{ index: 1, instances: 0 }]), []);
});

test("stripPostProcess removes scripts the CLI would reject the file for", () => {
  const settings = { layer_height: "0.2", post_process: ["/usr/bin/klipper_estimator"] };
  assert.deepEqual(stripPostProcess(settings), { layer_height: "0.2", post_process: [] });
  // Nothing to strip -> null, so the archive isn't rewritten needlessly.
  assert.equal(stripPostProcess({ post_process: [""] }), null);
  assert.equal(stripPostProcess({ layer_height: "0.2" }), null);
});

test("prusaIniToOrca translates PrusaSlicer settings to Orca keys", () => {
  const orca = prusaIniToOrca(
    [
      "layer_height = 0.25",
      "perimeters = 3",
      "fill_density = 25%", // percent is allowed for the infill density
      "fill_pattern = rectilinear", // Orca calls it zig-zag
      "external_perimeter_speed = 50%", // relative speed: Orca can't take it
      "perimeter_speed = 60",
      "machine_max_speed_x = 200,100", // [normal, silent] list kept whole
      "temperature = 215,240", // per extruder: objects use extruder 2
      "filament_type = PLA;PETG",
      "post_process = /bin/evil.sh", // unknown key: never copied
      "print_host = 10.0.0.5",
      "travel_speed = 350 --post-process=x", // known key, hostile value: rejected
    ].join("\n"),
    2,
  );
  assert.deepEqual(orca, {
    layer_height: "0.25",
    wall_loops: "3",
    sparse_infill_density: "25%",
    sparse_infill_pattern: "zig-zag",
    inner_wall_speed: "60",
    machine_max_speed_x: "200,100",
    nozzle_temperature: "240",
    filament_type: "PETG",
  });
});

test("toCliFlags spells Orca settings the way its CLI expects", () => {
  assert.deepEqual(
    toCliFlags({ layer_height: "0.25", sparse_infill_density: "25%" }),
    ["--layer-height=0.25", "--sparse-infill-density=25%"],
  );
});

test("usedExtruder picks the majority assignment, ignoring inherit (0)", () => {
  const xml = `<config>
    <object><metadata type="object" key="extruder" value="2"/>
      <volume><metadata type="volume" key="extruder" value="0"/></volume>
      <volume><metadata type="volume" key="extruder" value="0"/></volume>
    </object>
    <object><metadata type="object" key="extruder" value="2"/></object>
    <object><metadata type="object" key="extruder" value="1"/></object>
  </config>`;
  assert.equal(usedExtruder(xml), 2);
  assert.equal(usedExtruder(""), 1);
});

test("flattenPreset resolves the inherits chain, children overriding parents", () => {
  const presets = {
    fdm_filament_common: { name: "fdm_filament_common", filament_density: ["1"], filament_cost: ["0"] },
    fdm_filament_pla: { name: "fdm_filament_pla", inherits: "fdm_filament_common", filament_density: ["1.24"] },
    "Bambu PLA Basic @BBL X1C": { name: "Bambu PLA Basic @BBL X1C", inherits: "fdm_filament_pla", filament_cost: ["24.99"] },
  };
  const flat = flattenPreset("Bambu PLA Basic @BBL X1C", (n) => presets[n]);
  assert.deepEqual(flat, {
    name: "Bambu PLA Basic @BBL X1C",
    filament_density: ["1.24"], // only defined on a base: the reason to flatten
    filament_cost: ["24.99"],
  });
  assert.throws(() => flattenPreset("missing", () => undefined), /not found/);
  assert.throws(
    () => flattenPreset("a", (n) => ({ name: n, inherits: n === "a" ? "b" : "a" })),
    /cycle/,
  );
});

test("genericPresetSet makes the presets loadable together on a large bed", () => {
  const set = genericPresetSet({
    machine: { name: "Bambu Lab P1S 0.4 nozzle", from: "system", printable_area: ["0x0", "256x0", "256x256", "0x256"], bed_exclude_area: ["0x0", "18x0", "18x28", "0x28"] },
    process: { name: "0.20mm Standard @BBL X1C", compatible_printers: ["Bambu Lab X1 Carbon 0.4 nozzle"], compatible_printers_condition: "" },
    filament: { name: "Bambu PLA Basic @BBL X1C", compatible_printers: [] },
  });
  // The CLI refuses a process whose compatible_printers lacks the machine.
  assert.deepEqual(set.process.compatible_printers, ["Bambu Lab P1S 0.4 nozzle"]);
  assert.equal("compatible_printers_condition" in set.process, false);
  assert.equal(set.filament.from, "system");
  // Large models must not fail just for exceeding a real printer's bed.
  assert.deepEqual(set.machine.printable_area, ["0x0", "1000x0", "1000x1000", "0x1000"]);
  assert.deepEqual(set.machine.bed_exclude_area, []);
});
