import { test } from "node:test";
import assert from "node:assert/strict";
import {
  importFromPrintables,
  listPrintablesUpstreamFiles,
  parsePrintablesUrl,
} from "@/lib/import/printables";

test("parsePrintablesUrl returns the model id for printables hosts", () => {
  assert.equal(
    parsePrintablesUrl(new URL("https://www.printables.com/model/678-cable-clip")),
    "678",
  );
  assert.equal(
    parsePrintablesUrl(new URL("https://printables.com/model/1234")),
    "1234",
  );
});

test("parsePrintablesUrl rejects non-printables or non-model URLs", () => {
  assert.equal(parsePrintablesUrl(new URL("https://example.com/model/1")), null);
  assert.equal(parsePrintablesUrl(new URL("https://www.printables.com/search")), null);
  // guards against a look-alike host
  assert.equal(parsePrintablesUrl(new URL("https://notprintables.com/model/1")), null);
});

test("importFromPrintables imports .scad from otherFiles and skips unknown types", async (t) => {
  // Parametric OpenSCAD sources live in Printables' "other files" group and
  // download anonymously like stls; anything outside MODEL_EXTENSIONS (.zip
  // here) is skipped. Documents the extension gate that makes .scad import
  // work with no importer-specific code.
  const print = {
    name: "Servo Horn",
    description: "d",
    summary: null,
    tags: [],
    images: [],
    stls: [{ id: "1", name: "horn.3mf", fileSize: 10 }],
    slas: null,
    otherFiles: [
      { id: "2", name: "horn.scad", fileSize: 5 },
      { id: "3", name: "sources.zip", fileSize: 5 },
    ],
  };
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const data = body.query.startsWith("query Print")
      ? { print }
      : {
          getDownloadLink: {
            ok: true,
            output: { link: `https://files.printables.com/${body.variables.id}` },
          },
        };
    return new Response(JSON.stringify({ data }), { status: 200 });
  });

  const project = await importFromPrintables(
    new URL("https://www.printables.com/model/678-servo-horn"),
    "678",
  );
  assert.deepEqual(
    project.assets.filter((a) => a.kind === "model").map((a) => a.filename),
    ["horn.3mf", "horn.scad"],
  );
});

test("importFromPrintables asks to confirm before importing a model with many files", async (t) => {
  // A model with a lot of files stops for a Continue/Cancel confirmation before
  // any download link is resolved; it reports the projected count and, once the
  // caller confirms, imports them all (no cap).
  const print = {
    name: "Big Set",
    description: "d",
    summary: null,
    tags: [],
    images: [],
    stls: Array.from({ length: 15 }, (_, i) => ({ id: String(i), name: `part${i}.3mf`, fileSize: 10 })),
    slas: null,
    otherFiles: null,
  };
  let downloadCalls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.query.startsWith("query Print")) {
      return new Response(JSON.stringify({ data: { print } }), { status: 200 });
    }
    downloadCalls++;
    return new Response(
      JSON.stringify({
        data: { getDownloadLink: { ok: true, output: { link: `https://files/${body.variables.id}` } } },
      }),
      { status: 200 },
    );
  });

  const unconfirmed = await importFromPrintables(
    new URL("https://www.printables.com/model/678-big"),
    "678",
  );
  assert.equal(unconfirmed.needsConfirmation, true);
  assert.equal(unconfirmed.fileCount, 15);
  // No download links were resolved while waiting for confirmation.
  assert.equal(downloadCalls, 0);
  assert.equal(unconfirmed.assets.filter((a) => a.kind === "model").length, 0);

  const confirmed = await importFromPrintables(
    new URL("https://www.printables.com/model/678-big"),
    "678",
    { confirmManyFiles: true },
  );
  assert.ok(!confirmed.needsConfirmation);
  assert.equal(confirmed.assets.filter((a) => a.kind === "model").length, 15);
});

test("listPrintablesUpstreamFiles maps files to ids + modified tokens for sync", () => {
  // The ids must match what importFromPrintables stamps on its assets
  // ("file:<id>") — the sync planner joins the two worlds on them.
  const files = listPrintablesUpstreamFiles({
    name: "Benchy",
    description: null,
    summary: null,
    tags: [],
    category: null,
    images: [],
    stls: [{ id: "49068", name: "benchy.3mf", fileSize: 10, modified: "2020-11-26T12:50:39+00:00" }],
    slas: null,
    otherFiles: [
      { id: "7", name: "box.scad", fileSize: 5, modified: null },
      // Non-model files (readme, zip sources) never enter the sync domain.
      { id: "8", name: "readme.txt", fileSize: 1, modified: null },
    ],
  });
  assert.deepEqual(
    files.map((f) => [f.sourceFileId, f.filename, f.modifiedAt, f.fileType]),
    [
      ["file:49068", "benchy.3mf", "2020-11-26T12:50:39+00:00", "stl"],
      ["file:7", "box.scad", null, "other_file"],
    ],
  );
});
