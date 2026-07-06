import { test } from "node:test";
import assert from "node:assert/strict";
import { platformFromSourceUrl } from "@/lib/platform";

test("platformFromSourceUrl detects each platform by host", () => {
  assert.equal(
    platformFromSourceUrl("https://makerworld.com/en/models/12345-thing"),
    "makerworld",
  );
  assert.equal(
    platformFromSourceUrl("https://www.printables.com/model/678-thing"),
    "printables",
  );
  assert.equal(
    platformFromSourceUrl(
      "https://cad.onshape.com/documents/abc/w/def/e/ghi",
    ),
    "onshape",
  );
});

test("platformFromSourceUrl returns null for unknown or missing URLs", () => {
  assert.equal(platformFromSourceUrl(null), null);
  assert.equal(platformFromSourceUrl(undefined), null);
  assert.equal(platformFromSourceUrl(""), null);
  assert.equal(platformFromSourceUrl("not a url"), null);
  assert.equal(platformFromSourceUrl("https://example.com/models/1"), null);
  // guards against a naive substring match on a lookalike host
  assert.equal(platformFromSourceUrl("https://notprintables.com/x"), null);
});
