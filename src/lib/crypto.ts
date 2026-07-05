import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

// Symmetric encryption for secrets we must store and later reuse (e.g. a user's
// Bambu Cloud access token). AES-256-GCM with a key derived from an app secret.
//
// The key comes from BAMBU_TOKEN_SECRET, falling back to BETTER_AUTH_SECRET so
// existing deployments need no new configuration. Rotating that secret
// invalidates stored ciphertexts (users simply reconnect).

const SECRET =
  process.env.BAMBU_TOKEN_SECRET?.trim() ||
  process.env.BETTER_AUTH_SECRET?.trim();

// A fixed salt is fine here: the secret is high-entropy and per-deployment, and
// the salt only needs to be stable so the derived key is reproducible.
const KEY = SECRET
  ? scryptSync(SECRET, "stl-proj-mgmt/secret-box", 32)
  : null;

const VERSION = "v1";

function requireKey() {
  if (!KEY) {
    throw new Error(
      "Cannot encrypt secrets: set BAMBU_TOKEN_SECRET or BETTER_AUTH_SECRET",
    );
  }
  return KEY;
}

export function encryptSecret(plaintext: string): string {
  const key = requireKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptSecret(encoded: string): string {
  const key = requireKey();
  const [version, ivB64, tagB64, dataB64] = encoded.split(":");
  if (version !== VERSION || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("Malformed ciphertext");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
