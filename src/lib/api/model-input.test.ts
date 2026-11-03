import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createInputFromBody,
  resolveAttachments,
  updateInputFromPatch,
  type CurrentModelState,
} from "@/lib/api/model-input";
import { CreateModelBody, UpdateModelBody } from "@/lib/api/schemas";
import { signUploadToken } from "@/lib/api/upload-token";

const key = Buffer.alloc(32, 3);
const staged = {
  key: "uploads/0b5e7d3a-8d0e-4b9e-9a51-2f6f0c1d2e3f/part.3mf",
  filename: "part.3mf",
  size: 10,
  kind: "model" as const,
};

const current: CurrentModelState = {
  id: "0b5e7d3a-8d0e-4b9e-9a51-2f6f0c1d2e3f",
  title: "Bracket",
  description: "Print in PETG",
  categoryId: "1b5e7d3a-8d0e-4b9e-9a51-2f6f0c1d2e3f",
  tags: ["petg"],
  bom: [{ name: "M3 screw", quantity: "4", link: null, imageUrl: null, section: null }],
  videos: [{ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", position: 1 }],
};

// The core's update takes the whole editable state; a PATCH that names one field must not wipe the others (the classic partial-update bug).
test("a PATCH keeps every field it doesn't mention", () => {
  const input = updateInputFromPatch(current, UpdateModelBody.parse({ title: "Bracket v2" }), []);
  assert.equal(input.title, "Bracket v2");
  assert.equal(input.description, current.description);
  assert.equal(input.categoryId, current.categoryId);
  assert.deepEqual(input.tags, current.tags);
  assert.deepEqual(input.bom, current.bom);
  assert.deepEqual(input.removedFileIds, []);
});

// Videos aren't editable through the API, so they must ride along unchanged.
test("a PATCH can't drop the gallery's linked videos", () => {
  const input = updateInputFromPatch(current, UpdateModelBody.parse({ tags: [] }), []);
  assert.deepEqual(input.videos, current.videos);
  assert.deepEqual(input.tags, []);
});

// null is a value ("back to Other"); only an absent key means "unchanged".
test("categoryId: null clears it, absent keeps it", () => {
  assert.equal(
    updateInputFromPatch(current, UpdateModelBody.parse({ categoryId: null }), []).categoryId,
    null,
  );
  assert.equal(
    updateInputFromPatch(current, UpdateModelBody.parse({}), []).categoryId,
    current.categoryId,
  );
});

test("unknown PATCH fields are rejected rather than ignored", () => {
  assert.equal(UpdateModelBody.safeParse({ titel: "typo" }).success, false);
});

test("slice: false opts a file out of print estimates", () => {
  const { token } = signUploadToken(staged, "u1", key);
  const files = resolveAttachments([{ upload: token, slice: false }], "files", "u1", key);
  assert.ok(Array.isArray(files));
  const input = createInputFromBody(
    CreateModelBody.parse({ title: "Bracket", files: [{ upload: token, slice: false }] }),
    files,
  );
  assert.deepEqual(input.skipSliceKeys, [staged.key]);
  assert.equal(input.files[0].kind, "model");
  // Defaults fill what the body left out.
  assert.equal(input.description, "");
  assert.equal(input.categoryId, null);
});

// A model saved with some of its files silently missing would be worse than a failed request; the error points at the bad handle.
test("a bad upload handle fails the request and names the field", () => {
  const { token } = signUploadToken(staged, "u1", key);
  const result = resolveAttachments(
    [{ upload: token }, { upload: "forged" }],
    "addFiles",
    "u1",
    key,
  );
  assert.ok("error" in result);
  assert.match(result.error, /addFiles\.1\.upload/);
});
