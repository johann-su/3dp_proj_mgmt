import type { MetadataRoute } from "next";

// No blanket disallow: the catalog's auth gate (proxy.ts redirects every
// unauthenticated page to /sign-in) already keeps a crawler from indexing
// anything real, so a "Disallow: /" was never protecting content — only
// costing us the one path where robots.txt actually matters.
//
// /api/files/** is where signed, expiring, token-bearing download URLs live
// (image/PDF serving, and — since the MCP server, issue #96 — the URLs
// get_model_documents/search_models hand LLM clients to fetch directly). It's
// explicitly allowed rather than left to the default: a *disallow* here would
// make a policy-abiding fetcher (a client's "open this link" step, not the MCP
// tool calls themselves — those aren't robots.txt-gated) refuse the URL
// outright, exactly the "Failed to fetch" this was tuned to avoid. The
// standard advice to keep bearer-token URLs out of a search index doesn't
// apply cleanly here — robots.txt can't tell "a search engine" from "an LLM
// client fetching on the user's behalf" by path alone, and the latter is the
// point of the feature — so this trades that narrow protection for MCP
// document/thumbnail fetches working.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/api/files/",
    },
  };
}
