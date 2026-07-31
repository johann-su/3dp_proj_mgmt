// Slice-push tokens (issue #122): the credential a slicer's post-processing
// hook presents to POST /api/models/:id/slice-push. Pure crypto/string logic
// only — the table lookup lives in the route, so this module stays importable
// from unit tests without opening a DB pool (see AGENTS.md).
//
// Shape: "pvpush_<43 chars base64url>" = a `pvpush_` prefix (so a leaked token
// is greppable and recognisable in a slicer config or a support paste) over 32
// bytes of CSPRNG randomness. Only the SHA-256 of the whole string is stored,
// like a password digest: the plaintext is shown once at mint time and cannot
// be recovered from the database.

import { createHash, randomBytes } from "node:crypto";

export const TOKEN_PREFIX = "pvpush_";

// 32 random bytes -> 43 base64url chars, no padding.
const SECRET_BYTES = 32;
const SECRET_CHARS = 43;

// Leading characters kept in clear (prefix included) so the settings list can
// tell two tokens apart. Short enough to leave the secret unguessable: it
// reveals 6 of 43 random chars, ~36 bits of a 256-bit secret.
const DISPLAY_CHARS = TOKEN_PREFIX.length + 6;

export type MintedPushToken = {
  // Shown to the user exactly once; never stored.
  token: string;
  // What goes in the database.
  tokenHash: string;
  prefix: string;
};

export function mintPushToken(): MintedPushToken {
  const token = `${TOKEN_PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;
  return {
    token,
    tokenHash: hashPushToken(token),
    prefix: displayPrefix(token),
  };
}

// The stored form. A plain SHA-256 rather than scrypt/bcrypt on purpose: the
// input is 256 bits of CSPRNG output, not a human-chosen password, so there is
// no dictionary to slow down — and the ingest route has to hash on every push.
export function hashPushToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function displayPrefix(token: string): string {
  return token.slice(0, DISPLAY_CHARS);
}

// True for strings shaped like a token we could have minted. Cheap gate in
// front of the database lookup so malformed junk never reaches it.
export function isPushTokenFormat(value: string): boolean {
  return (
    value.startsWith(TOKEN_PREFIX) &&
    value.length === TOKEN_PREFIX.length + SECRET_CHARS &&
    /^[A-Za-z0-9_-]+$/.test(value.slice(TOKEN_PREFIX.length))
  );
}

// Pulls the token out of an Authorization header. Accepts "Bearer <token>"
// (what the shipped hook script sends) and a bare token, because hand-rolled
// curl one-liners get this wrong constantly and the token itself is the only
// thing that actually authenticates. Returns null when there's nothing that
// even looks like a token — the caller answers 401 either way.
export function parsePushTokenHeader(header: string | null): string | null {
  if (!header) return null;
  const value = header.trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(value);
  const token = (bearer ? bearer[1] : value).trim();
  return isPushTokenFormat(token) ? token : null;
}
