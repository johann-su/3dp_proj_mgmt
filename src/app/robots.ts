import type { MetadataRoute } from "next";

// No blanket disallow: the catalog's auth gate (proxy.ts redirects every
// unauthenticated page to /sign-in) already keeps a crawler from indexing
// anything real, so a "Disallow: /" was never protecting content — only
// costing us the one path where robots.txt actually matters.
//
// /api/files/** is where signed, expiring, token-bearing download URLs live
// (image/PDF serving, and — since the MCP server, issue #96 — the URLs
// get_model_documents/search_models hand LLM clients). It's explicitly allowed
// rather than left to the default: a *disallow* here would make a
// policy-abiding fetcher (a client's "open this link" step, not the MCP tool
// calls themselves — those aren't robots.txt-gated) refuse the URL outright.
// The standard advice to keep bearer-token URLs out of a search index doesn't
// apply cleanly here — robots.txt can't tell "a search engine" from "an LLM
// client fetching on the user's behalf" by path alone.
//
// This is *not*, however, what makes MCP document access work, and it was once
// described here as though it were. A client can refuse a URL for reasons
// robots.txt has no say over — claude.ai only fetches URLs that came from the
// user's message or from web_search, so a link that appeared only in a tool
// result fails regardless of what this file says. That is why the MCP server
// serves document text and figures as content instead (read_document,
// get_document_images — see docs/architecture/mcp.md). Loosening robots.txt
// further would not have fixed it.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/api/files/",
    },
  };
}
