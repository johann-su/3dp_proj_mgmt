import { test } from "node:test";
import assert from "node:assert/strict";
import robots from "@/app/robots";

// A disallow here would make a policy-abiding fetcher (a client's "open this
// link" step, not the MCP tool calls themselves) refuse the token-bearing
// download URLs get_model_documents/search_models hand out — the generic
// "Failed to fetch" this is tuned to avoid. auth (proxy.ts) is what actually
// keeps everything else out of a crawler's hands, not robots.txt.
test("robots.txt allows /api/files/ and carries no disallow", () => {
  const { rules } = robots();
  const rule = Array.isArray(rules) ? rules[0] : rules;
  assert.equal(rule.allow, "/api/files/");
  assert.equal(rule.disallow, undefined);
});
