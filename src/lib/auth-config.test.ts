import { test } from "node:test";
import assert from "node:assert/strict";
import { envFlag, passwordLoginEnabled } from "@/lib/auth-config";

// Operators write these by hand in a compose file or Dokploy's env editor, so
// the usual spellings of "on" all have to land the same way.
test("envFlag accepts true/1 in any casing or padding", () => {
  for (const raw of ["true", "TRUE", " True ", "1"]) {
    assert.equal(envFlag(raw), true, raw);
  }
});

test("envFlag treats anything else — including unset — as off", () => {
  for (const raw of [undefined, "", "false", "0", "yes", "no"]) {
    assert.equal(envFlag(raw), false, String(raw));
  }
});

test("password login is on unless explicitly disabled", () => {
  assert.equal(passwordLoginEnabled(undefined, true), true);
  assert.equal(passwordLoginEnabled("false", true), true);
});

test("DISABLE_PASSWORD_LOGIN makes the IdP the only way in", () => {
  assert.equal(passwordLoginEnabled("true", true), false);
});

// The safety valve: without an IdP configured, honouring the flag would leave
// nobody able to sign in, so it is ignored rather than locking the operator out.
test("DISABLE_PASSWORD_LOGIN is ignored when no OIDC provider is configured", () => {
  assert.equal(passwordLoginEnabled("true", false), true);
});
