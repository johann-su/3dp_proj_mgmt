// Post-sign-in redirect targets ("open a shared model link → sign in → land
// on that model"). The callback travels as a `callbackUrl` query param on
// /sign-in (set by the proxy) and as a proxy-set request header (so pages
// whose server-side getSession() check fails — expired/forged cookie — can
// preserve the destination too). Because the value round-trips through the
// URL bar it is attacker-controlled: everything here validates it down to an
// in-app path to rule out open-redirect/unvalidated-forward abuse.

/** Request header the proxy uses to hand pages their original path+query. */
export const CALLBACK_PATH_HEADER = "x-callback-path";

const AUTH_OR_API_PATH = /^\/(sign-in|sign-up|api)(\/|$)/;

const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Validate an untrusted callback value down to a safe in-app path.
 * Returns the path (incl. query/hash) or null if it is anything else.
 */
export function safeCallbackPath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) {
    return null;
  }
  // Must be an origin-relative path: "/..." but not "//host" (protocol-
  // relative) or "/\host" (browsers treat the backslash as a slash).
  if (!raw.startsWith("/") || raw[1] === "/" || raw[1] === "\\") return null;
  // Control characters could split headers or smuggle a second URL.
  if (CONTROL_CHARS.test(raw)) return null;
  // Belt and braces: parsed against a known origin it must stay on it.
  let url: URL;
  try {
    url = new URL(raw, "http://internal");
  } catch {
    return null;
  }
  if (url.origin !== "http://internal") return null;
  // Never bounce back into the auth pages (redirect loop) or API routes.
  if (AUTH_OR_API_PATH.test(url.pathname)) return null;
  return raw;
}

/**
 * Build the /sign-in URL (path only) that returns to `callbackPath` after
 * login. Invalid/unsafe callbacks and the homepage collapse to plain
 * "/sign-in".
 */
export function signInPath(callbackPath: unknown): string {
  const safe = safeCallbackPath(callbackPath);
  if (!safe || safe === "/") return "/sign-in";
  return `/sign-in?callbackUrl=${encodeURIComponent(safe)}`;
}
