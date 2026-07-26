import { createHmac, scryptSync, timingSafeEqual } from "node:crypto";

// Signed access tokens for /api/files/[id]. The route requires either a
// session cookie or one of these tokens; tokens exist for the two consumers
// that cannot send cookies:
//  - the next/image optimizer, which fetches upstream images through a mock
//    request that carries no headers (see fetchInternalImage in Next), and
//  - slicer deep links (Orca/Bambu download the URL themselves).
//
// A token is scoped to a single file id and expires. Format: "<exp>.<sig>"
// with exp in epoch seconds and sig = base64url HMAC-SHA256 over
// "<fileId>\n<exp>" — URL-safe, so it works both as a query param and as a
// path segment (Orca names downloads after the URL's last path segment and
// does NOT strip query strings, so deep links carry the token in the path).

const SECRET =
  process.env.FILE_TOKEN_SECRET?.trim() ||
  process.env.BETTER_AUTH_SECRET?.trim() ||
  process.env.BAMBU_TOKEN_SECRET?.trim();

// Same reasoning as crypto.ts: a fixed salt is fine, the secret is
// high-entropy and per-deployment; the context string just keeps this key
// separate from the secret-box key derived from the same secret.
const KEY = SECRET ? scryptSync(SECRET, "stl-proj-mgmt/file-token", 32) : null;

// Expiries are bucketed to week boundaries so a file's URL stays byte-stable
// across renders for at least a week (browser + next/image optimizer caches
// stay warm) while still expiring: tokens are valid between one and two weeks.
const WINDOW_SECONDS = 7 * 24 * 3600;

function requireKey() {
  if (!KEY) {
    throw new Error(
      "Cannot sign file tokens: set BETTER_AUTH_SECRET (or FILE_TOKEN_SECRET)",
    );
  }
  return KEY;
}

function signature(fileId: string, expiresAt: number) {
  return createHmac("sha256", requireKey())
    .update(`${fileId}\n${expiresAt}`)
    .digest("base64url");
}

export function signFileToken(fileId: string, expiresAt: number): string {
  return `${expiresAt}.${signature(fileId, expiresAt)}`;
}

export function verifyFileToken(
  fileId: string,
  token: string,
  nowMs = Date.now(),
): boolean {
  const dot = token.indexOf(".");
  if (dot === -1) return false;
  const expiresAt = Number(token.slice(0, dot));
  if (!Number.isSafeInteger(expiresAt) || expiresAt * 1000 <= nowMs) {
    return false;
  }
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(signature(fileId, expiresAt));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function fileToken(fileId: string, nowMs = Date.now()): string {
  const expiresAt =
    (Math.floor(nowMs / 1000 / WINDOW_SECONDS) + 2) * WINDOW_SECONDS;
  return signFileToken(fileId, expiresAt);
}

// Image URL for <Image>/<img> src attributes, valid without a session.
export function fileSrc(fileId: string): string {
  return `/api/files/${fileId}?token=${fileToken(fileId)}`;
}

// Same file, same token — but as the /api/files/<id>/<token>/<filename> path
// route (reusing the [id] handler; filename is cosmetic, the id is
// authoritative — see that route). Some consumers decide how to handle a URL
// by its apparent extension, and fileSrc()'s bare-UUID form gives them
// nothing to go on: Orca/Bambu Studio needed this for slicer deep links
// (file-download-menu.tsx), and the MCP server (issue #96) hands this form to
// LLM clients for the same reason — get_model_documents' downloadUrl and
// search_models' thumbnailUrl are otherwise indistinguishable from an opaque
// API endpoint to a client that won't fetch what it can't identify.
export function namedFileSrc(fileId: string, filename: string): string {
  return `/api/files/${fileId}/${fileToken(fileId)}/${encodeURIComponent(filename)}`;
}

// Token subject for one file of a version snapshot (the version-preview page,
// /api/files/versions/[versionId]/[index]): historical files have no
// model_files row, so the token pins the version row id plus the index into
// its immutable snapshot file list instead.
export function versionFileTokenId(versionId: number, index: number): string {
  return `version:${versionId}:${index}`;
}

// URL for a snapshot file, valid without a session (next/image can't send
// cookies). Lives under /api/files/** so next.config's images.localPatterns
// keeps covering it.
export function versionFileSrc(versionId: number, index: number): string {
  const token = fileToken(versionFileTokenId(versionId, index));
  return `/api/files/versions/${versionId}/${index}?token=${token}`;
}
