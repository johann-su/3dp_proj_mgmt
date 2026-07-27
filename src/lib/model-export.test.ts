import { test } from "node:test";
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";
import {
  buildModelExportZip,
  exportZipName,
  exportedVersionNumber,
  type ExportFile,
  type ModelExportManifest,
} from "@/lib/model-export";

const bytes = (text: string) => new TextEncoder().encode(text);

function file(
  kind: ExportFile["kind"],
  filename: string,
  body = filename,
): ExportFile {
  return { kind, filename, data: bytes(body) };
}

function exportZip(input: Partial<Parameters<typeof buildModelExportZip>[0]>) {
  return unzipSync(
    buildModelExportZip({
      title: "Widget",
      description: "",
      version: 1,
      tags: [],
      category: null,
      sourceUrl: null,
      onshapeMicroversion: null,
      exportedAt: new Date("2026-07-27T10:00:00Z"),
      bomItems: [],
      files: [],
      ...input,
    }),
  );
}

function manifestOf(entries: Record<string, Uint8Array>): ModelExportManifest {
  return JSON.parse(strFromU8(entries["metadata.json"]));
}

test("files are grouped into folders by kind", () => {
  // The whole point of the export: one predictable tree per model, so a user
  // can find the printable, the manual and the photos without the app.
  const entries = exportZip({
    files: [
      file("model", "part.3mf"),
      file("pdf", "manual.pdf"),
      file("image", "cover.png"),
    ],
  });
  assert.deepEqual(Object.keys(entries).sort(), [
    "README.md",
    "documents/manual.pdf",
    "files/part.3mf",
    "images/cover.png",
    "metadata.json",
  ]);
  assert.equal(strFromU8(entries["files/part.3mf"]), "part.3mf");
});

test("README.md carries the title, the version and the description verbatim", () => {
  // The description is Markdown source already, so it must not be reformatted
  // or escaped on the way into the file. The version line says which snapshot
  // of the model this copy is — the same number as the zip's filename.
  const entries = exportZip({
    title: "Widget",
    description: "## Parts\n\n- one\n- two",
    version: 5,
  });
  assert.equal(
    strFromU8(entries["README.md"]),
    "# Widget\n\n*Print Vault export · version 5*\n\n## Parts\n\n- one\n- two\n",
  );
});

test("the zip is named after the model title and the exported version", () => {
  // A stray zip on disk has to say which version of the model it holds.
  assert.equal(exportZipName("Cable clip v2", 5), "Cable-clip-v2_v5.zip");
});

test("version numbering matches the History panel, including pre-versioning models", () => {
  // History numbers the retained rows 1..n (the cap prunes the oldest, so the
  // count *is* the current number), and a model with no rows shows as v1.
  assert.equal(exportedVersionNumber(5), 5);
  assert.equal(exportedVersionNumber(0), 1);
});

test("bom.csv is written only when the model has BOM items", () => {
  // "Nothing to include → include nothing", matching the CSV download route,
  // rather than shipping a header-only file that looks like a real BOM.
  assert.ok(!("bom.csv" in exportZip({})));
  const entries = exportZip({
    bomItems: [
      { name: "M3 screw", quantity: "4", link: null, imageUrl: null, section: null },
    ],
  });
  assert.equal(
    strFromU8(entries["bom.csv"]),
    "name,quantity,link,image\r\nM3 screw,4,,\r\n",
  );
});

test("files sharing a name within a folder are suffixed, case-insensitively", () => {
  // model_files.filename isn't unique, and the zip is extracted onto
  // case-insensitive filesystems — so "Part.3mf" collides with "part.3mf" and
  // neither may overwrite the other. Same name in a different folder is fine.
  const entries = exportZip({
    files: [
      file("model", "part.3mf", "first"),
      file("model", "part.3mf", "second"),
      file("model", "Part.3mf", "third"),
      file("image", "part.3mf", "image"),
    ],
  });
  assert.equal(strFromU8(entries["files/part.3mf"]), "first");
  assert.equal(strFromU8(entries["files/part-2.3mf"]), "second");
  assert.equal(strFromU8(entries["files/Part-3.3mf"]), "third");
  assert.equal(strFromU8(entries["images/part.3mf"]), "image");
});

test("metadata.json carries what the folder tree can't", () => {
  // The manifest is the whole reason an export can be re-imported: tags, the
  // category and BOM sections have no place in the tree, and the file entries
  // pin down each file's kind rather than leaving it to be guessed.
  const manifest = manifestOf(
    exportZip({
      title: "Widget",
      description: "Body",
      version: 3,
      tags: ["bracket", "petg"],
      category: "Tools",
      bomItems: [
        {
          name: "M3 screw",
          quantity: "4",
          link: null,
          imageUrl: null,
          section: "Hardware",
        },
      ],
      files: [file("model", "part.3mf"), file("image", "cover.png")],
    }),
  );
  assert.equal(manifest.model.title, "Widget");
  assert.deepEqual(manifest.model.tags, ["bracket", "petg"]);
  assert.equal(manifest.model.category, "Tools");
  assert.equal(manifest.bom[0].section, "Hardware");
  assert.deepEqual(
    manifest.files.map((f) => [f.path, f.kind]),
    [
      ["files/part.3mf", "model"],
      ["images/cover.png", "image"],
    ],
  );
});

test("the manifest publishes only BOM fields, never the rows' database ids", () => {
  // Callers hand over whole bom_items rows, and the zip is a file users pass
  // around — this instance's row/model ids have no business travelling in it.
  const manifest = manifestOf(
    exportZip({
      bomItems: [
        {
          id: "row-uuid",
          modelId: "model-uuid",
          position: 0,
          name: "M3 screw",
          quantity: "4",
          link: null,
          imageUrl: null,
          section: null,
        } as never,
      ],
    }),
  );
  assert.deepEqual(Object.keys(manifest.bom[0]).sort(), [
    "imageUrl",
    "link",
    "name",
    "quantity",
    "section",
  ]);
});

test("tags are sorted so an unchanged model exports an identical manifest", () => {
  // Tag rows arrive in join order, which the database is free to vary.
  assert.deepEqual(
    manifestOf(exportZip({ tags: ["petg", "bracket"] })).model.tags,
    ["bracket", "petg"],
  );
});

test("the manifest records a file's real name even when the zip entry was renamed", () => {
  // Two files can share a name, so the entry gets a "-2" suffix — but the
  // model's own filename is the one to restore on import, so both are kept.
  const manifest = manifestOf(
    exportZip({ files: [file("model", "part.3mf"), file("model", "part.3mf")] }),
  );
  assert.deepEqual(
    manifest.files.map((f) => [f.path, f.filename]),
    [
      ["files/part.3mf", "part.3mf"],
      ["files/part-2.3mf", "part.3mf"],
    ],
  );
});

test("customizer-generated variants are flagged in the manifest", () => {
  // They stay in the zip (an offline copy holds everything the model page
  // offers) but an import must be able to tell them from real source files.
  const manifest = manifestOf(
    exportZip({
      files: [
        { ...file("model", "source.scad"), generated: false },
        { ...file("model", "variant.3mf"), generated: true },
      ],
    }),
  );
  assert.deepEqual(
    manifest.files.map((f) => f.generated),
    [false, true],
  );
});

test("filenames can't escape their folder (zip slip)", () => {
  // Filenames are user-controlled (upload + rename), so a "../" in one must
  // not make an extractor write outside the destination directory.
  const entries = exportZip({
    files: [
      file("model", "../../etc/passwd"),
      file("pdf", ".."),
      file("image", "C:\\Windows\\evil.png"),
    ],
  });
  assert.deepEqual(Object.keys(entries).sort(), [
    "README.md",
    "documents/file",
    "files/passwd",
    "images/evil.png",
    "metadata.json",
  ]);
});
