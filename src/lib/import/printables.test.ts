import { test } from "node:test";
import assert from "node:assert/strict";
import { importFromPrintables, parsePrintablesUrl } from "@/lib/import/printables";

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
