import { test } from "node:test";
import assert from "node:assert/strict";
import { contentTypeForFilename, sanitizeRename } from "@/lib/file-kind";

test("contentTypeForFilename maps allowlisted extensions, ignoring case", () => {
  // Serve-time content types come from the extension, never from what the
  // uploader claimed — a text/html "image" served inline would be stored XSS.
  assert.equal(contentTypeForFilename("part.3MF"), "model/3mf");
  assert.equal(contentTypeForFilename("photo.jpeg"), "image/jpeg");
  assert.equal(contentTypeForFilename("manual.pdf"), "application/pdf");
});

test("contentTypeForFilename falls back to octet-stream for unknown extensions", () => {
  assert.equal(contentTypeForFilename("weird.exe"), "application/octet-stream");
  assert.equal(contentTypeForFilename("no-extension"), "application/octet-stream");
});

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
