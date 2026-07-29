import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isContentHash,
  sameSourceKey,
  sourceKeyFromUrl,
  sourceKeyUrlFragment,
} from "@/lib/duplicate-key";

// The whole point of comparing keys instead of sourceUrl strings: the stored
// URL keeps its hash, which on MakerWorld selects a print profile. Two imports
// of the same design with different profiles are the same design.
test("MakerWorld print profile hashes don't change the design identity", () => {
  const a = sourceKeyFromUrl("https://makerworld.com/en/models/12345#profileId-99");
  const b = sourceKeyFromUrl("https://makerworld.com/de/models/12345#profileId-42");
  assert.deepEqual(a, { platform: "makerworld", id: "12345" });
  assert.ok(sameSourceKey(a, b));
});

// Onshape's identity is the document id alone: a version-pinned import must
// still flag against an existing workspace-pinned import of the same document,
// and the imported tab may differ.
test("Onshape branch, version and tab pins all resolve to the document", () => {
  const workspace = sourceKeyFromUrl(
    "https://cad.onshape.com/documents/0123456789abcdef01234567/w/89abcdef0123456789abcdef/e/fedcba9876543210fedcba98",
  );
  const version = sourceKeyFromUrl(
    "https://cad.onshape.com/documents/0123456789abcdef01234567/v/aaaabbbbccccddddeeeeffff",
  );
  assert.deepEqual(workspace, {
    platform: "onshape",
    id: "0123456789abcdef01234567",
  });
  assert.ok(sameSourceKey(workspace, version));
});

test("Printables model ids are read straight off the slug path", () => {
  assert.deepEqual(
    sourceKeyFromUrl("https://www.printables.com/model/987654-cable-clip"),
    { platform: "printables", id: "987654" },
  );
});

// Anything we can't pin to a platform id has no identity to compare, so it
// must never be flagged — a look-alike host least of all.
test("non-platform and look-alike URLs produce no key", () => {
  for (const url of [
    "https://evil-makerworld.com/en/models/12345",
    "https://makerworld.com/en/collections/778",
    "https://example.com/model/12345",
    "not a url",
    null,
  ]) {
    assert.equal(sourceKeyFromUrl(url), null, `${url} should not resolve`);
  }
});

test("different designs on the same platform are different keys", () => {
  assert.equal(
    sameSourceKey(
      sourceKeyFromUrl("https://makerworld.com/en/models/12"),
      sourceKeyFromUrl("https://makerworld.com/en/models/123"),
    ),
    false,
  );
});

// The hash round-trips through the client (like `size`), so a stored value has
// to look like a SHA-256 digest and nothing else.
test("only lowercase 64-char hex counts as a content hash", () => {
  assert.ok(isContentHash("a".repeat(64)));
  assert.equal(isContentHash("A".repeat(64)), false, "uppercase");
  assert.equal(isContentHash("a".repeat(63)), false, "too short");
  assert.equal(isContentHash("z".repeat(64)), false, "not hex");
  assert.equal(isContentHash(undefined), false);
});

// The fragment is only a SQL prefilter; it over-matches by design (id 12 also
// matches model 123), which is why callers re-parse every candidate.
test("URL fragments are substrings of the URLs they must narrow", () => {
  const printables = "https://www.printables.com/model/987654-cable-clip";
  const key = sourceKeyFromUrl(printables);
  assert.ok(key);
  assert.ok(printables.includes(sourceKeyUrlFragment(key)));
  // …and Printables' /model/ fragment must not match MakerWorld's /models/.
  assert.ok(
    !"https://makerworld.com/en/models/987654".includes(
      sourceKeyUrlFragment(key),
    ),
  );
});
