import { test } from "node:test";
import assert from "node:assert/strict";
import { cn, isNextRedirectError } from "@/lib/utils";

test("cn merges conflicting tailwind classes, last one wins", () => {
  assert.equal(cn("p-2", "p-4"), "p-4");
  assert.equal(cn("text-sm", false && "hidden", "font-bold"), "text-sm font-bold");
});

test("isNextRedirectError only matches the NEXT_REDIRECT sentinel", () => {
  assert.equal(isNextRedirectError({ digest: "NEXT_REDIRECT;replace;/x" }), true);
  assert.equal(isNextRedirectError({ digest: "NEXT_NOT_FOUND" }), false);
  assert.equal(isNextRedirectError(new Error("boom")), false);
  assert.equal(isNextRedirectError(null), false);
  assert.equal(isNextRedirectError("NEXT_REDIRECT"), false);
});
