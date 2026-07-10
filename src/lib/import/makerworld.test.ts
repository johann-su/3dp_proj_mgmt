import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMakerworldUrl, preferEnglish } from "@/lib/import/makerworld";

test("parseMakerworldUrl returns the model id for makerworld hosts", () => {
  assert.equal(
    parseMakerworldUrl(new URL("https://makerworld.com/en/models/12345-cool-thing")),
    "12345",
  );
  // subdomains count as makerworld
  assert.equal(
    parseMakerworldUrl(new URL("https://www.makerworld.com/models/678")),
    "678",
  );
});

// MakerWorld returns each text field as an original + a single English
// machine-translation; the translation is empty for already-English models. We
// import English when it exists, else the original — matching the site default.
test("preferEnglish uses the translation when present, else the original", () => {
  // non-English original → take the English translation
  assert.equal(preferEnglish("Model Airplane Rudder Angle", "航模舵角"), "Model Airplane Rudder Angle");
  // already-English model → translation is empty, fall back to the original
  assert.equal(preferEnglish("", "Isobutane stove stand"), "Isobutane stove stand");
  assert.equal(preferEnglish(undefined, "Isobutane stove stand"), "Isobutane stove stand");
  // whitespace-only translation is treated as absent
  assert.equal(preferEnglish("   ", "航模舵角"), "航模舵角");
  // nothing at all → empty string, never undefined
  assert.equal(preferEnglish(undefined, undefined), "");
});

test("parseMakerworldUrl rejects non-makerworld or non-model URLs", () => {
  assert.equal(parseMakerworldUrl(new URL("https://example.com/models/1")), null);
  assert.equal(parseMakerworldUrl(new URL("https://makerworld.com/en/search")), null);
  // guards against a look-alike host
  assert.equal(parseMakerworldUrl(new URL("https://notmakerworld.com/models/1")), null);
});
