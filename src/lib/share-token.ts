import { randomBytes } from "node:crypto";
import { envFlag } from "@/lib/auth-config";

// Pure helpers for public share links (see src/lib/share-links.ts for the DB
// side). Kept free of DB imports so they can be unit-tested.

// 32 random bytes → 43 base64url chars. The token is the whole credential, so
// it is unguessable on its own; nothing else (ids, signatures) rides along.
export function generateShareToken(): string {
  return randomBytes(32).toString("base64url");
}

const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

// Shape check before any DB lookup, so junk from the URL bar (or a probe for
// something larger) never reaches a query.
export function isWellFormedShareToken(token: string | null | undefined): token is string {
  return typeof token === "string" && SHARE_TOKEN_RE.test(token);
}

// On unless the operator opts out. DISABLE_PUBLIC_SHARING=true hides the
// controls *and* stops serving existing links (rows are kept, so unsetting it
// brings them back) — the kill switch for instances that must stay private.
export function publicSharingEnabled(
  raw: string | undefined = process.env.DISABLE_PUBLIC_SHARING,
): boolean {
  return !envFlag(raw);
}

export function sharePagePath(token: string): string {
  return `/share/${token}`;
}

// A model reached through a shared collection.
export function sharedModelPath(token: string, modelId: string): string {
  return `/share/${token}/models/${modelId}`;
}

// File URL for anonymous viewers. Lives under /api/files/** so next.config's
// images.localPatterns covers it, and carries the share token (not a
// file-token) so revoking the link cuts off files immediately. Always has a
// query string, so callers may append `&download=1`.
export function sharedFileSrc(token: string, fileId: string): string {
  return `/api/files/shared/${fileId}?share=${token}`;
}
