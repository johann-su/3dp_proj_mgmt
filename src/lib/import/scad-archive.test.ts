import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import { extractScadFiles } from "@/lib/import/scad-archive";

function streamOf(data: Uint8Array): ReadableStream<Uint8Array> {
  // Emit in small chunks so the test exercises the incremental push path,
  // not just a single-shot buffer.
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < data.byteLength; i += 4096) {
        controller.enqueue(data.subarray(i, i + 4096));
      }
      controller.close();
    },
  });
}

const opts = { fallbackName: "download.zip", maxFileBytes: 32 * 1024 * 1024 };

test("extractScadFiles pulls .scad entries out of a raw-file archive, skipping geometry", async () => {
  // The raw-model zip bundles big geometry next to the .scad sources; only the
  // sources should come back, named by their basename (folders stripped).
  const zip = zipSync({
    "SCAD File/Parametric Model Maker.scad": strToU8("// model maker\n"),
    "SCAD File/Advanced Settings.scad": strToU8("// advanced\n"),
    "Raw 3mf export/big.3mf": new Uint8Array(200_000),
    "__MACOSX/._junk.scad": strToU8("resource fork"),
  });
  const scads = await extractScadFiles(streamOf(zip), opts);
  assert.deepEqual(
    scads.map((s) => s.name).sort(),
    ["Advanced Settings.scad", "Parametric Model Maker.scad"],
  );
  const maker = scads.find((s) => s.name === "Parametric Model Maker.scad");
  assert.equal(new TextDecoder().decode(maker!.bytes), "// model maker\n");
});

test("extractScadFiles handles a bare .scad served directly (not zipped)", async () => {
  const source = strToU8("cube([10,10,10]);\n");
  const scads = await extractScadFiles(streamOf(source), {
    ...opts,
    fallbackName: "Thing.scad",
  });
  assert.equal(scads.length, 1);
  assert.equal(scads[0].name, "Thing.scad");
  assert.equal(new TextDecoder().decode(scads[0].bytes), "cube([10,10,10]);\n");
});

test("extractScadFiles ignores a non-zip, non-.scad download", async () => {
  const scads = await extractScadFiles(streamOf(strToU8("<html>oops</html>")), {
    ...opts,
    fallbackName: "index.html",
  });
  assert.deepEqual(scads, []);
});

test("extractScadFiles drops an oversized .scad entry rather than buffering it", async () => {
  const zip = zipSync({
    "ok.scad": strToU8("small\n"),
    "huge.scad": new Uint8Array(2_000_000),
  });
  const scads = await extractScadFiles(streamOf(zip), { ...opts, maxFileBytes: 1_000_000 });
  assert.deepEqual(scads.map((s) => s.name), ["ok.scad"]);
});
