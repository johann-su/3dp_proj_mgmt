// The OAuth authorize request as it reaches /mcp/authorize, our `loginPage`.
// BetterAuth's /oauth2/authorize sends the browser there with the client's
// query plus its own signature fields when it has no session for the request.
// Once the user has signed in (the proxy bounces through /sign-in and back),
// the page re-issues the original request to /oauth2/authorize, which now
// finds the session and carries on to consent. Pure, so the stripping rules
// are unit-tested.

// Added by BetterAuth when it signs the query (src/signed-query.ts there).
const SIGNATURE_PARAMS = ["sig", "exp", "ba_iat", "ba_pl", "ba_param"];

/**
 * The client's original authorize query, without BetterAuth's signature
 * fields and without what would send the user straight back to the login
 * page: `prompt=login` and `max_age` both ask for a fresh sign-in, which the
 * user has just been through (or, with an existing session, the proxy let
 * through) — forwarding them unchanged would loop.
 */
export function resumeAuthorizeQuery(search: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const [key, value] of search) {
    if (SIGNATURE_PARAMS.includes(key) || key === "max_age") continue;
    if (key === "prompt") {
      const rest = value.split(" ").filter((p) => p && p !== "login");
      if (rest.length) out.append(key, rest.join(" "));
      continue;
    }
    out.append(key, value);
  }
  return out;
}

/** Next.js searchParams (string | string[]) back to URLSearchParams, repeats kept. */
export function toSearchParams(params: Record<string, string | string[] | undefined>): URLSearchParams {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) out.append(key, v);
  }
  return out;
}
