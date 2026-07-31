import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TOKEN_PREFIX,
  displayPrefix,
  hashPushToken,
  isPushTokenFormat,
  mintPushToken,
  parsePushTokenHeader,
} from "@/lib/push-token";

test("a minted token is recognisable, unique, and stored only as a hash", () => {
  const a = mintPushToken();
  const b = mintPushToken();

  // The pvpush_ prefix is what makes a leaked token greppable in a slicer
  // config or a support paste.
  assert.ok(a.token.startsWith(TOKEN_PREFIX));
  assert.equal(isPushTokenFormat(a.token), true);
  assert.notEqual(a.token, b.token);

  // What lands in the database must never be the token itself: the whole
  // point of hashing is that a database leak yields no usable credential.
  assert.equal(a.tokenHash, hashPushToken(a.token));
  assert.notEqual(a.tokenHash, a.token);
  assert.ok(!a.tokenHash.includes(a.token.slice(TOKEN_PREFIX.length)));
});

test("the stored prefix identifies a token without revealing it", () => {
  const { token, prefix } = mintPushToken();
  // Long enough to tell two tokens apart in the settings list...
  assert.equal(prefix, displayPrefix(token));
  assert.ok(prefix.startsWith(TOKEN_PREFIX));
  // ...short enough that the secret stays unguessable from it alone.
  assert.ok(prefix.length < token.length / 2);
});

test("only well-formed tokens reach the database lookup", () => {
  const { token } = mintPushToken();
  assert.equal(isPushTokenFormat(token), true);
  // Right shape, wrong length — a truncated paste.
  assert.equal(isPushTokenFormat(token.slice(0, -1)), false);
  // Right length, no prefix — some other bearer token.
  assert.equal(isPushTokenFormat(token.slice(TOKEN_PREFIX.length)), false);
  // Base64url only: anything else can't be something we minted.
  assert.equal(isPushTokenFormat(`${TOKEN_PREFIX}${"!".repeat(43)}`), false);
  assert.equal(isPushTokenFormat(""), false);
});

test("the Authorization header parses with or without the Bearer scheme", () => {
  // Hand-rolled curl one-liners get the scheme wrong constantly, and the
  // token is the only thing that actually authenticates — so accept both.
  const { token } = mintPushToken();
  assert.equal(parsePushTokenHeader(`Bearer ${token}`), token);
  assert.equal(parsePushTokenHeader(`bearer ${token}`), token);
  assert.equal(parsePushTokenHeader(`  ${token}  `), token);
  assert.equal(parsePushTokenHeader(null), null);
  assert.equal(parsePushTokenHeader("Bearer not-a-push-token"), null);
  // A session cookie or an MCP OAuth token must not be mistaken for one.
  assert.equal(parsePushTokenHeader("Basic dXNlcjpwYXNz"), null);
});
