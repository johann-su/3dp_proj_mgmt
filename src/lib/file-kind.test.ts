import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeRename } from "@/lib/file-kind";

test("sanitizeRename keeps the original extension when the user omits it", () => {
  // The rename UI only ever lets someone edit the base name, but the
  // server can't trust that — it must still enforce this itself.
  assert.equal(sanitizeRename("model.3mf", "renamed"), "renamed.3mf");
});

test("sanitizeRename strips a user-supplied extension and reapplies the real one", () => {
  // A crafted rename can't smuggle in a different extension and change
  // what kind the file is treated as (allowedExtensions/sliceEligible key
  // off the extension, not the DB's `kind` column alone).
  assert.equal(sanitizeRename("model.3mf", "totally-safe.exe"), "totally-safe.exe.3mf");
});

test("sanitizeRename is a no-op for an unchanged name", () => {
  assert.equal(sanitizeRename("model.3mf", "model.3mf"), "model.3mf");
});

test("sanitizeRename falls back to the original name when the proposal is blank", () => {
  assert.equal(sanitizeRename("model.3mf", "   "), "model.3mf");
});

test("sanitizeRename handles files without an extension", () => {
  assert.equal(sanitizeRename("README", "notes"), "notes");
});
