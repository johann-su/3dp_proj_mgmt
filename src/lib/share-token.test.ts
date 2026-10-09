import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateShareToken,
  isWellFormedShareToken,
  publicSharingEnabled,
  sharedFileSrc,
  sharedBomImageSrc,
  sharedSlicerFileBase,
} from "@/lib/share-token";

test("generated share tokens are well-formed and unique", () => {
  const a = generateShareToken();
  const b = generateShareToken();
  assert.ok(isWellFormedShareToken(a));
  assert.ok(isWellFormedShareToken(b));
  assert.notEqual(a, b);
});

// The token comes straight from the URL bar; anything that isn't the exact
// shape we mint must be rejected before it reaches a DB query.
test("isWellFormedShareToken rejects anything but a 43-char base64url token", () => {
  const good = generateShareToken();
  assert.equal(isWellFormedShareToken(good.slice(1)), false);
  assert.equal(isWellFormedShareToken(`${good}A`), false);
  assert.equal(isWellFormedShareToken(`${good.slice(1)}/`), false);
  assert.equal(isWellFormedShareToken(`${good.slice(1)}=`), false);
  assert.equal(isWellFormedShareToken(""), false);
  assert.equal(isWellFormedShareToken(null), false);
  assert.equal(isWellFormedShareToken(undefined), false);
});

// Sharing is on by default; only an explicit truthy opt-out turns it off.
test("publicSharingEnabled is on unless DISABLE_PUBLIC_SHARING is truthy", () => {
  assert.equal(publicSharingEnabled(undefined), true);
  assert.equal(publicSharingEnabled(""), true);
  assert.equal(publicSharingEnabled("false"), true);
  assert.equal(publicSharingEnabled("true"), false);
  assert.equal(publicSharingEnabled(" TRUE "), false);
  assert.equal(publicSharingEnabled("1"), false);
});

// Callers append "&download=1", and next.config only allows next/image srcs
// under /api/files/**.
test("sharedFileSrc stays under /api/files and carries a query string", () => {
  const src = sharedFileSrc("tok", "file-id");
  assert.ok(src.startsWith("/api/files/"));
  assert.equal(new URL(`${src}&download=1`, "http://x").searchParams.get("share"), "tok");
});

// Orca names the download after the URL's last path segment and keeps any
// query string, so the slicer form must carry the token in the path with no
// "?" — the menu appends "/<name>.3mf".
test("sharedSlicerFileBase carries the share token in the path, not the query", () => {
  const url = new URL(`${sharedSlicerFileBase("tok", "file-id")}/part.3mf`, "http://x");
  assert.equal(url.search, "");
  assert.ok(url.pathname.startsWith("/api/files/"));
  assert.deepEqual(url.pathname.split("/").slice(-3), ["file-id", "tok", "part.3mf"]);
});

// Anonymous visitors name a BOM item, never a URL — the member `?url=` mode
// of the proxy must not appear in the public src.
test("sharedBomImageSrc addresses the proxy by item id, without a url param", () => {
  const url = new URL(sharedBomImageSrc("tok", "item-id"), "http://x");
  assert.equal(url.pathname, "/api/bom-image");
  assert.equal(url.searchParams.get("share"), "tok");
  assert.equal(url.searchParams.get("item"), "item-id");
  assert.equal(url.searchParams.has("url"), false);
});
