import { test } from "node:test";
import assert from "node:assert/strict";

// The module derives its key from the environment at load time, so the secret
// must be set before the (dynamic) import.
process.env.BAMBU_TOKEN_SECRET ??= "unit-test-secret";

test("encryptSecret/decryptSecret round-trips arbitrary strings", async () => {
  const { encryptSecret, decryptSecret } = await import("@/lib/crypto");
  const token = "bambu-access-token-πø€";
  assert.equal(decryptSecret(encryptSecret(token)), token);
});

test("each encryption uses a fresh IV but stays decryptable", async () => {
  const { encryptSecret, decryptSecret } = await import("@/lib/crypto");
  const a = encryptSecret("same-plaintext");
  const b = encryptSecret("same-plaintext");
  assert.notEqual(a, b);
  assert.equal(decryptSecret(a), "same-plaintext");
  assert.equal(decryptSecret(b), "same-plaintext");
});

test("tampered or malformed ciphertexts are rejected", async () => {
  const { encryptSecret, decryptSecret } = await import("@/lib/crypto");
  const [version, iv, tag, data] = encryptSecret("secret").split(":");
  const flipped = Buffer.from(data, "base64");
  flipped[0] ^= 0xff; // GCM auth tag must catch a single flipped bit
  assert.throws(() =>
    decryptSecret([version, iv, tag, flipped.toString("base64")].join(":")),
  );
  assert.throws(() => decryptSecret("v1:not-a-ciphertext"));
  assert.throws(() => decryptSecret(`v0:${iv}:${tag}:${data}`)); // unknown version
});
