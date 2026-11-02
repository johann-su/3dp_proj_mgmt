import { test } from "node:test";
import assert from "node:assert/strict";
import {
  apiKeyFromHeaders,
  hasScope,
  parseScopes,
  permissionsToScopes,
  scopesToPermissions,
} from "@/lib/api/scopes";

// The plugin stores { resource: actions[] }; the API speaks "resource:action".
// The two spellings must round-trip exactly or a key silently loses access.
test("scopes round-trip through the plugin's permission map", () => {
  const scopes = parseScopes(["files:read", "models:write", "models:read"]);
  assert.ok(Array.isArray(scopes));
  assert.deepEqual(scopesToPermissions(scopes), {
    models: ["read", "write"],
    files: ["read"],
  });
  assert.deepEqual(permissionsToScopes(scopesToPermissions(scopes)), [
    "models:read",
    "models:write",
    "files:read",
  ]);
});

// A key must never gain a scope the API doesn't know how to enforce — e.g. a
// permission written by hand or by a future plugin version.
test("unknown permissions are dropped, not trusted", () => {
  assert.deepEqual(
    permissionsToScopes({ models: ["read", "admin"], users: ["write"], files: "read" }),
    ["models:read"],
  );
  // A key created straight through /api/auth/api-key/create has none at all.
  assert.deepEqual(permissionsToScopes(null), []);
});

test("parseScopes rejects unknown scopes and empty selections", () => {
  assert.ok("error" in (parseScopes(["models:read", "models:delete"]) as object));
  assert.ok("error" in (parseScopes([]) as object));
  assert.ok("error" in (parseScopes("models:read") as object));
});

// Every write endpoint answers with the resource it changed, so write implies
// read on the *same* resource — and nothing else.
test("write implies read on the same resource only", () => {
  assert.equal(hasScope(["models:write"], "models:read"), true);
  assert.equal(hasScope(["models:read"], "models:write"), false);
  assert.equal(hasScope(["models:write"], "files:read"), false);
  assert.equal(hasScope(["files:write"], "files:read"), true);
});

test("the key is read from a Bearer header or x-api-key", () => {
  const key = "pv_abc123";
  assert.equal(apiKeyFromHeaders(new Headers({ authorization: `Bearer ${key}` })), key);
  assert.equal(apiKeyFromHeaders(new Headers({ authorization: `bearer ${key}` })), key);
  assert.equal(apiKeyFromHeaders(new Headers({ "x-api-key": key })), key);
  assert.equal(apiKeyFromHeaders(new Headers()), null);
});

// An MCP access token (a JWT) sent to /api/v1 by mistake must read as "no
// key", not cost a hashed DB lookup.
test("a bearer token without our prefix is not taken for an API key", () => {
  assert.equal(
    apiKeyFromHeaders(new Headers({ authorization: "Bearer eyJhbGciOiJFZERTQSJ9.x.y" })),
    null,
  );
});
