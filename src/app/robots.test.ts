import { test } from "node:test";
import assert from "node:assert/strict";
import robots from "@/app/robots";

// The MCP server (issue #96) hands LLM clients /api/files/** URLs and expects
// them to fetch it directly; a blanket "Disallow: /" makes a policy-abiding
// fetcher (not the MCP tool calls themselves, which aren't robots.txt-gated,
// but the client's follow-up "open this link" step) refuse them with a
// generic fetch failure that a human clicking the same link never hits.
test("robots.txt allows /api/files/ while still disallowing the rest of the catalog", () => {
  const { rules } = robots();
  const rule = Array.isArray(rules) ? rules[0] : rules;
  assert.equal(rule.disallow, "/");
  assert.equal(rule.allow, "/api/files/");
});
