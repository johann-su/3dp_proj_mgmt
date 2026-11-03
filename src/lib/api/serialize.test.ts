import { test } from "node:test";
import assert from "node:assert/strict";
import {
  serializeFile,
  serializeModel,
  type ModelDetailRow,
} from "@/lib/api/serialize";

const url = (path: string) => `https://prints.example${path}`;
const created = new Date("2026-11-01T10:00:00Z");

function fileRow(over: Partial<Parameters<typeof serializeFile>[0]> = {}) {
  return {
    id: "f0000000-0000-4000-8000-000000000001",
    kind: "model" as const,
    filename: "part.3mf",
    size: 100,
    contentType: "model/3mf",
    position: 0,
    imported: false,
    generatedFromId: null,
    sliceStatus: null,
    sliceSource: null,
    sliceApprox: null,
    sliceError: null,
    sliceEngine: null,
    slicePrinter: null,
    printTimeSeconds: null,
    filamentGrams: null,
    printerInfo: null,
    ...over,
  };
}

function modelRow(over: Partial<ModelDetailRow> = {}): ModelDetailRow {
  return {
    id: "m0000000-0000-4000-8000-000000000001",
    title: "Bracket",
    description: "PETG",
    category: { id: "c1", name: "Tools", slug: "tools" },
    tags: ["petg", "bracket"],
    owner: { id: "u1", name: "Ada" },
    sourceUrl: null,
    sourceRevision: null,
    coverImageId: null,
    createdAt: created,
    updatedAt: created,
    files: [],
    bom: [],
    videos: [],
    ...over,
  };
}

// The serializer projects field by field: an S3 key, content hash or other
// internal column on the row must never reach a response.
test("internal file columns never leak into the response", () => {
  const row = { ...fileRow(), s3Key: "uploads/secret/part.3mf", contentHash: "a".repeat(64) };
  const out = serializeFile(row, url) as Record<string, unknown>;
  assert.equal("s3Key" in out, false);
  assert.equal("contentHash" in out, false);
  assert.equal(out.downloadUrl, "https://prints.example/api/v1/files/f0000000-0000-4000-8000-000000000001");
});

// null sliceStatus means estimates don't apply (images, .step), which a
// client must be able to tell apart from "pending".
test("files without estimates have print: null; sliced ones carry the numbers", () => {
  assert.equal(serializeFile(fileRow({ kind: "image", filename: "a.png" }), url).print, null);
  const sliced = serializeFile(
    fileRow({ sliceStatus: "ok", sliceSource: "slicer", sliceApprox: true, printTimeSeconds: 3600 }),
    url,
  );
  assert.equal(sliced.print?.status, "ok");
  assert.equal(sliced.print?.approximate, true);
  assert.equal(sliced.print?.printTimeSeconds, 3600);
});

test("a model's source is reported with its platform and revision", () => {
  const out = serializeModel(
    modelRow({
      sourceUrl: "https://cad.onshape.com/documents/0123456789abcdef01234567/w/0123456789abcdef01234568",
      sourceRevision: "0123456789abcdef01234569",
    }),
    url,
  );
  assert.deepEqual(out.source, {
    platform: "onshape",
    url: "https://cad.onshape.com/documents/0123456789abcdef01234567/w/0123456789abcdef01234568",
    revision: "0123456789abcdef01234569",
  });
  assert.equal(serializeModel(modelRow(), url).source, null);
});

test("files come back in their display order and tags sorted", () => {
  const out = serializeModel(
    modelRow({
      files: [
        fileRow({ id: "f0000000-0000-4000-8000-000000000002", position: 1 }),
        fileRow({ id: "f0000000-0000-4000-8000-000000000001", position: 0 }),
      ],
    }),
    url,
  );
  assert.deepEqual(
    out.files.map((f) => f.position),
    [0, 1],
  );
  assert.deepEqual(out.tags, ["bracket", "petg"]);
  assert.equal(out.url, "https://prints.example/models/m0000000-0000-4000-8000-000000000001");
  assert.equal(out.createdAt, "2026-11-01T10:00:00.000Z");
});
