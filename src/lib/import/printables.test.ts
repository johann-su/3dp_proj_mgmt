import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePrintablesUrl } from "@/lib/import/printables";

test("parsePrintablesUrl returns the model id for printables hosts", () => {
  assert.equal(
    parsePrintablesUrl(new URL("https://www.printables.com/model/678-cable-clip")),
    "678",
  );
  assert.equal(
    parsePrintablesUrl(new URL("https://printables.com/model/1234")),
    "1234",
  );
});

test("parsePrintablesUrl rejects non-printables or non-model URLs", () => {
  assert.equal(parsePrintablesUrl(new URL("https://example.com/model/1")), null);
  assert.equal(parsePrintablesUrl(new URL("https://www.printables.com/search")), null);
  // guards against a look-alike host
  assert.equal(parsePrintablesUrl(new URL("https://notprintables.com/model/1")), null);
});
