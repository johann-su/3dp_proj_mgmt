import { test } from "node:test";
import assert from "node:assert/strict";
import { safeCallbackPath, signInPath } from "@/lib/callback-url";

// The callback value arrives via the URL bar (?callbackUrl=) and a proxy-set
// header, so it is attacker-controlled: everything that isn't a plain in-app
// path must be rejected or the sign-in flow becomes an open redirect.

test("accepts an in-app path and keeps its query and hash", () => {
  assert.equal(
    safeCallbackPath("/models/abc?tab=files#history"),
    "/models/abc?tab=files#history",
  );
});

test("rejects absolute URLs — an off-site target is an open redirect", () => {
  assert.equal(safeCallbackPath("https://evil.example/phish"), null);
  assert.equal(safeCallbackPath("javascript:alert(1)"), null);
});

test("rejects protocol-relative and backslash look-alikes", () => {
  // Browsers resolve "//host" to https://host and treat "\" as "/".
  assert.equal(safeCallbackPath("//evil.example"), null);
  assert.equal(safeCallbackPath("/\\evil.example"), null);
});

test("rejects control characters (header splitting / URL smuggling)", () => {
  assert.equal(safeCallbackPath("/models\r\nSet-Cookie: x=1"), null);
  assert.equal(safeCallbackPath("/models\tabc"), null);
});

test("rejects auth and API paths so sign-in can't loop or forward blindly", () => {
  assert.equal(safeCallbackPath("/sign-in"), null);
  assert.equal(safeCallbackPath("/sign-up?callbackUrl=%2F"), null);
  assert.equal(safeCallbackPath("/api/files/abc"), null);
  // Look-alike prefixes are real pages and stay allowed.
  assert.equal(safeCallbackPath("/api-docs"), "/api-docs");
});

test("rejects non-strings (repeated ?callbackUrl= params arrive as arrays)", () => {
  assert.equal(safeCallbackPath(["/a", "/b"]), null);
  assert.equal(safeCallbackPath(undefined), null);
  assert.equal(safeCallbackPath(""), null);
});

test("signInPath carries a safe callback, percent-encoded", () => {
  assert.equal(
    signInPath("/models/abc?tab=files"),
    "/sign-in?callbackUrl=%2Fmodels%2Fabc%3Ftab%3Dfiles",
  );
});

test("signInPath collapses unsafe callbacks and the homepage to plain /sign-in", () => {
  assert.equal(signInPath("https://evil.example"), "/sign-in");
  assert.equal(signInPath("/"), "/sign-in");
  assert.equal(signInPath(null), "/sign-in");
});
