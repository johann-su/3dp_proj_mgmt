import { test } from "node:test";
import assert from "node:assert/strict";

// The module derives its key from the environment at load time, so the secret
// must be set before the (dynamic) import.
process.env.BETTER_AUTH_SECRET ??= "unit-test-secret";

const FILE_ID = "0f80559e-2ffa-4b26-a26b-4a2e04ac2bc0";

test("a signed token verifies for its file until it expires", async () => {
  const { signFileToken, verifyFileToken } = await import("@/lib/file-token");
  const exp = Math.floor(Date.now() / 1000) + 60;
  const token = signFileToken(FILE_ID, exp);
  assert.equal(verifyFileToken(FILE_ID, token), true);
  // The same token is rejected once `now` passes the embedded expiry.
  assert.equal(verifyFileToken(FILE_ID, token, (exp + 1) * 1000), false);
});

test("a token is scoped to one file id", async () => {
  const { signFileToken, verifyFileToken } = await import("@/lib/file-token");
  const token = signFileToken(FILE_ID, Math.floor(Date.now() / 1000) + 60);
  assert.equal(
    verifyFileToken("11111111-2222-4333-8444-555555555555", token),
    false,
  );
});

test("tampering with expiry or signature invalidates the token", async () => {
  const { signFileToken, verifyFileToken } = await import("@/lib/file-token");
  const exp = Math.floor(Date.now() / 1000) + 60;
  const [, sig] = signFileToken(FILE_ID, exp).split(".");
  // Extending the expiry without re-signing must fail.
  assert.equal(verifyFileToken(FILE_ID, `${exp + 3600}.${sig}`, Date.now()), false);
  assert.equal(verifyFileToken(FILE_ID, `${exp}.${sig.slice(0, -2)}xx`), false);
  assert.equal(verifyFileToken(FILE_ID, "garbage"), false);
});

test("fileToken buckets expiry so URLs stay stable within a week", async () => {
  // Stable URLs let the browser and the next/image optimizer cache images
  // across renders; the bucket still guarantees at least a week of validity.
  const { fileToken, verifyFileToken } = await import("@/lib/file-token");
  const now = Date.now();
  const later = now + 6 * 24 * 3600 * 1000; // < one bucket width apart
  assert.equal(fileToken(FILE_ID, now), fileToken(FILE_ID, now + 60_000));
  const token = fileToken(FILE_ID, now);
  assert.equal(verifyFileToken(FILE_ID, token, later), true);
});

test("version-file tokens are scoped to one version and file index", async () => {
  // The version-preview page serves snapshot files by (version row, index);
  // a token minted for one file must not unlock its neighbours.
  const { fileToken, verifyFileToken, versionFileTokenId } = await import(
    "@/lib/file-token"
  );
  const token = fileToken(versionFileTokenId(12, 0));
  assert.equal(verifyFileToken(versionFileTokenId(12, 0), token), true);
  assert.equal(verifyFileToken(versionFileTokenId(12, 1), token), false);
  assert.equal(verifyFileToken(versionFileTokenId(13, 0), token), false);
  // …and never for a regular file id.
  assert.equal(verifyFileToken(FILE_ID, token), false);
});
