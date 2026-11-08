// The handle POST /api/v1/uploads returns for a staged file, which a later create/update call attaches to a model. The browser flow echoes the staged descriptor (key, size, content hash) back through the client and the mutation core re-validates what it can; the API instead hands out a signed token over that descriptor, so an API client can't claim another size or hash (the hash drives duplicate detection), can't attach somebody else's staged upload, and gets one opaque string to pass around.
//
// Format: base64url(JSON claims) "." base64url(HMAC-SHA256), keyed separately from the file tokens (src/lib/file-token.ts) but from the same secret. Pure apart from reading the secret, so the rules are unit-tested with a fixed key.

import { createHmac, scryptSync, timingSafeEqual } from "node:crypto";
import type { FileKind } from "@/db/schema";

// Long enough to upload a batch of files and then create the model; short enough that a leaked handle is soon worthless.
export const UPLOAD_TOKEN_TTL_SECONDS = 24 * 3600;

export type StagedUpload = {
  key: string;
  filename: string;
  size: number;
  kind: FileKind;
  contentHash?: string;
};

type Claims = StagedUpload & { userId: string; exp: number };

const KINDS: readonly FileKind[] = ["model", "image", "pdf", "video"];

function mac(payload: string, key: Buffer): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function signUploadToken(
  upload: StagedUpload,
  userId: string,
  key: Buffer,
  nowMs = Date.now(),
): { token: string; expiresAt: Date } {
  const exp = Math.floor(nowMs / 1000) + UPLOAD_TOKEN_TTL_SECONDS;
  const claims: Claims = { ...upload, userId, exp };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return { token: `${payload}.${mac(payload, key)}`, expiresAt: new Date(exp * 1000) };
}

// The descriptor, or null when the token is malformed, tampered with, expired or was issued to another user.
export function verifyUploadToken(
  token: string,
  userId: string,
  key: Buffer,
  nowMs = Date.now(),
): StagedUpload | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(mac(payload, key));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let claims: Partial<Claims>;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    claims.userId !== userId ||
    typeof claims.exp !== "number" ||
    claims.exp * 1000 <= nowMs ||
    typeof claims.key !== "string" ||
    typeof claims.filename !== "string" ||
    typeof claims.size !== "number" ||
    !KINDS.includes(claims.kind as FileKind)
  ) {
    return null;
  }
  return {
    key: claims.key,
    filename: claims.filename,
    size: claims.size,
    kind: claims.kind as FileKind,
    ...(typeof claims.contentHash === "string" ? { contentHash: claims.contentHash } : {}),
  };
}

let cachedKey: Buffer | null = null;

// Derived lazily so importing this module never throws on an instance without a secret (the API is off there anyway).
export function uploadTokenKey(): Buffer {
  if (cachedKey) return cachedKey;
  const secret =
    process.env.FILE_TOKEN_SECRET?.trim() || process.env.BETTER_AUTH_SECRET?.trim();
  if (!secret) {
    throw new Error("Cannot sign upload tokens: set BETTER_AUTH_SECRET");
  }
  cachedKey = scryptSync(secret, "stl-proj-mgmt/upload-token", 32);
  return cachedKey;
}
