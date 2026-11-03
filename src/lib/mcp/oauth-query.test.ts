import { test } from "node:test";
import assert from "node:assert/strict";
import { resumeAuthorizeQuery, toSearchParams } from "@/lib/mcp/oauth-query";

// What BetterAuth appends when it redirects to the login page. Forwarding the signature fields would make /oauth2/authorize see unknown params; the client's own params (PKCE challenge, state, resource) must pass untouched.
test("resumeAuthorizeQuery drops the signature fields and keeps the client's request", () => {
  const out = resumeAuthorizeQuery(
    new URLSearchParams(
      "response_type=code&client_id=abc&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&code_challenge=xyz" +
        "&state=s1&resource=https%3A%2F%2Fprints.example%2Fapi%2Fmcp&exp=1&ba_iat=2&ba_param=client_id&ba_param=state&sig=zzz",
    ),
  );
  assert.equal(
    out.toString(),
    "response_type=code&client_id=abc&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&code_challenge=xyz" +
      "&state=s1&resource=https%3A%2F%2Fprints.example%2Fapi%2Fmcp",
  );
});

// The user has just signed in; asking for a fresh login again would bounce them back to the login page forever.
test("resumeAuthorizeQuery removes prompt=login and max_age but keeps other prompts", () => {
  assert.equal(resumeAuthorizeQuery(new URLSearchParams("client_id=a&prompt=login&max_age=0")).toString(), "client_id=a");
  assert.equal(
    resumeAuthorizeQuery(new URLSearchParams("client_id=a&prompt=login+consent")).get("prompt"),
    "consent",
  );
});

// RFC 8707 allows several resource params; Next.js hands repeats over as arrays.
test("toSearchParams keeps repeated parameters", () => {
  const out = toSearchParams({ resource: ["https://a/mcp", "https://b/mcp"], state: "s", missing: undefined });
  assert.deepEqual(out.getAll("resource"), ["https://a/mcp", "https://b/mcp"]);
  assert.equal(out.get("state"), "s");
  assert.equal(out.has("missing"), false);
});
