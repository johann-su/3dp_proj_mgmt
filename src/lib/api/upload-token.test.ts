import { test } from "node:test";
import assert from "node:assert/strict";
import {
  signUploadToken,
  UPLOAD_TOKEN_TTL_SECONDS,
  verifyUploadToken,
  type StagedUpload,
} from "@/lib/api/upload-token";

const key = Buffer.alloc(32, 7);
const now = Date.UTC(2026, 10, 2, 12);
const upload: StagedUpload = {
  key: "uploads/0b5e7d3a-8d0e-4b9e-9a51-2f6f0c1d2e3f/part.3mf",
  filename: "part.3mf",
  size: 1234,
  kind: "model",
  contentHash: "a".repeat(64),
};

test("an upload handle verifies back to the staged descriptor", () => {
  const { token } = signUploadToken(upload, "user-1", key, now);
  assert.deepEqual(verifyUploadToken(token, "user-1", key, now), upload);
});

// The point of signing: a client can't claim another size or content hash (the hash drives duplicate detection) by editing the payload.
test("a tampered handle is rejected", () => {
  const { token } = signUploadToken(upload, "user-1", key, now);
  const [payload, sig] = token.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  claims.size = 1;
  const forged = `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${sig}`;
  assert.equal(verifyUploadToken(forged, "user-1", key, now), null);
});

// One user's staged upload must not be attachable by another user's key.
test("a handle only works for the user it was issued to", () => {
  const { token } = signUploadToken(upload, "user-1", key, now);
  assert.equal(verifyUploadToken(token, "user-2", key, now), null);
});

test("a handle expires", () => {
  const { token, expiresAt } = signUploadToken(upload, "user-1", key, now);
  assert.equal(expiresAt.getTime(), now + UPLOAD_TOKEN_TTL_SECONDS * 1000);
  assert.equal(verifyUploadToken(token, "user-1", key, expiresAt.getTime()), null);
});

test("garbage and other keys' handles are rejected", () => {
  const { token } = signUploadToken(upload, "user-1", key, now);
  assert.equal(verifyUploadToken(token, "user-1", Buffer.alloc(32, 8), now), null);
  assert.equal(verifyUploadToken("not-a-token", "user-1", key, now), null);
  assert.equal(verifyUploadToken(".", "user-1", key, now), null);
});
