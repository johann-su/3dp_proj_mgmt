import { test } from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import {
  ArchiveImportError,
  parseExportReadme,
  readModelArchive,
} from "@/lib/import/archive";
import { buildModelExportZip, type ExportFile } from "@/lib/model-export";

const bytes = (text: string) => new TextEncoder().encode(text);

// A real export, so the round-trip tests exercise the format the exporter
// actually writes rather than a hand-built approximation of it.
function exported(input: Partial<Parameters<typeof buildModelExportZip>[0]> = {}) {
  return buildModelExportZip({
    title: "Widget",
    description: "How to print it",
    version: 3,
    tags: ["bracket", "petg"],
    category: "Tools",
    sourceUrl: null,
    onshapeMicroversion: null,
    exportedAt: new Date("2026-07-27T10:00:00Z"),
    videos: [],
    bomItems: [],
    files: [{ kind: "model", filename: "part.3mf", data: bytes("part") }],
    ...input,
  });
}

const file = (kind: ExportFile["kind"], filename: string): ExportFile => ({
  kind,
  filename,
  data: bytes(filename),
});

test("a freshly exported model round-trips through the importer", () => {
  // The contract the whole feature rests on: everything the create form
  // prefills comes back, including the two things the folder tree can't
  // carry — tags and the category.
  const draft = readModelArchive(
    exported({
      bomItems: [
        {
          name: "M3 screw",
          quantity: "4",
          link: null,
          imageUrl: null,
          section: "Hardware",
        },
      ],
      files: [file("model", "part.3mf"), file("pdf", "manual.pdf"), file("image", "a.png")],
    }),
  );
  assert.equal(draft.title, "Widget");
  assert.equal(draft.description, "How to print it");
  assert.deepEqual(draft.tags, ["bracket", "petg"]);
  assert.deepEqual(draft.categories, ["Tools"]);
  // Sections survive because they come from the manifest — bom.csv is flat.
  assert.deepEqual(draft.bom, [
    { name: "M3 screw", quantity: "4", link: null, imageUrl: null, section: "Hardware" },
  ]);
  assert.deepEqual(
    draft.files.map((f) => [f.kind, f.filename]),
    [
      ["model", "part.3mf"],
      ["pdf", "manual.pdf"],
      ["image", "a.png"],
    ],
  );
});

// Gallery videos are links, not files, so the zip tree can't carry them —
// they exist only in the manifest, and an archive is meant to be a full
// backup.
test("gallery videos survive the round trip through the manifest", () => {
  const draft = readModelArchive(
    exported({
      videos: [{ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", position: 1 }],
    }),
  );
  // The slot survives too: the video sat between two images, and re-importing
  // must not shuffle it to the end of the gallery.
  assert.deepEqual(draft.videos, [
    { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", position: 1 },
  ]);
  // Archives written before the field existed simply have no videos.
  assert.deepEqual(readModelArchive(exported()).videos, []);
});

test("per-file source provenance survives the round trip", () => {
  // So a model restored from an archive still syncs against the platform it
  // came from, instead of looking like a pile of manual uploads.
  const draft = readModelArchive(
    exported({
      sourceUrl: "https://makerworld.com/en/models/123",
      files: [
        {
          ...file("model", "plate.3mf"),
          imported: true,
          sourceFileId: "profile:456",
          sourceModifiedAt: "2026-01-02T03:04:05Z",
        },
      ],
    }),
  );
  assert.equal(draft.sourceUrl, "https://makerworld.com/en/models/123");
  assert.deepEqual(
    draft.files.map((f) => [f.imported, f.sourceFileId, f.sourceModifiedAt]),
    [[true, "profile:456", "2026-01-02T03:04:05Z"]],
  );
});

test("customizer-generated variants are skipped, with a warning", () => {
  // A variant's link to the .scad it came from can't cross instances, so
  // importing it would leave a detached duplicate of geometry the customizer
  // regenerates on demand.
  const draft = readModelArchive(
    exported({
      files: [
        file("model", "source.scad"),
        { ...file("model", "variant.3mf"), generated: true },
      ],
    }),
  );
  assert.deepEqual(
    draft.files.map((f) => f.filename),
    ["source.scad"],
  );
  assert.match(draft.warnings.join(" "), /generated/i);
});

test("archives exported before metadata.json fall back to their folder tree", () => {
  // Those zips are already on people's disks — the folder gives the kind, the
  // README the title and description, bom.csv a section-less BOM.
  const draft = readModelArchive(
    zipSync({
      "README.md": strToU8(
        "# Old Widget\n\n*Print Vault export · version 2*\n\nStill useful\n",
      ),
      "bom.csv": strToU8("name,quantity,link,image\r\nM3 screw,4,,\r\n"),
      "files/part.3mf": bytes("part"),
      "images/cover.png": bytes("img"),
    }),
  );
  assert.equal(draft.title, "Old Widget");
  assert.equal(draft.description, "Still useful");
  assert.deepEqual(draft.bom.map((b) => [b.name, b.section]), [["M3 screw", null]]);
  assert.deepEqual(
    draft.files.map((f) => [f.kind, f.filename]),
    [
      ["model", "part.3mf"],
      ["image", "cover.png"],
    ],
  );
});

test("README parsing keeps the description's own Markdown headings", () => {
  // Only the export's own title heading and version line are stripped — a
  // description that starts with "## Parts" must come back intact.
  assert.deepEqual(
    parseExportReadme("# Widget\n\n*Print Vault export · version 5*\n\n## Parts\n\n- one"),
    { title: "Widget", description: "## Parts\n\n- one" },
  );
});

test("a manifest can't relabel a file into a kind its extension doesn't allow", () => {
  // The manifest rides in on a user-supplied file. Stored content types are
  // derived from the extension and images are served inline from our origin,
  // so a ".html" claiming to be an image is exactly the input to reject.
  const draft = readModelArchive(
    zipSync({
      "metadata.json": strToU8(
        JSON.stringify({
          formatVersion: 1,
          model: { title: "Evil" },
          files: [
            { path: "files/part.3mf", kind: "model", filename: "part.3mf" },
            { path: "images/x.png", kind: "image", filename: "evil.html" },
          ],
        }),
      ),
      "files/part.3mf": bytes("part"),
      "images/x.png": bytes("img"),
    }),
  );
  assert.deepEqual(
    draft.files.map((f) => f.filename),
    ["part.3mf"],
  );
});

test("a manifest filename can't escape into a path", () => {
  // Same zip-slip reasoning as the export side: the name is round-tripped
  // user input, and it becomes a stored filename on the way back in.
  const draft = readModelArchive(
    zipSync({
      "metadata.json": strToU8(
        JSON.stringify({
          formatVersion: 1,
          files: [
            { path: "files/part.3mf", kind: "model", filename: "../../evil.3mf" },
          ],
        }),
      ),
      "files/part.3mf": bytes("part"),
    }),
  );
  assert.deepEqual(
    draft.files.map((f) => f.filename),
    ["evil.3mf"],
  );
});

test("an archive with no model files is rejected", () => {
  // Every model needs at least one printable, so this is the wrong zip —
  // better to say so here than to hand the form a draft it can't save.
  assert.throws(
    () =>
      readModelArchive(
        zipSync({ "README.md": strToU8("# Photos"), "images/a.png": bytes("img") }),
      ),
    ArchiveImportError,
  );
});

test("something that isn't a zip is rejected", () => {
  assert.throws(() => readModelArchive(bytes("not a zip at all")), ArchiveImportError);
});

test("the title falls back to the uploaded file's name", () => {
  // A zip whose README and manifest are both missing a title still opens the
  // form with something in the field rather than an empty required input.
  const draft = readModelArchive(zipSync({ "files/part.3mf": bytes("part") }), {
    fallbackTitle: "Bracket_v5.zip",
  });
  assert.equal(draft.title, "Bracket_v5");
});
