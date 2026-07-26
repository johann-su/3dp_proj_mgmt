import type { MetadataRoute } from "next";

// The catalog is private (auth is the only real gate), but there's no reason
// to also let it get indexed and surfaced in search results for anyone who
// isn't already looking for it.
//
// /api/files/** is carved out: it's where the MCP server (issue #96) hands
// LLM clients signed, expiring download URLs for manuals/images/thumbnails
// (get_model_documents, search_models' thumbnailUrl, …), expecting the client
// to fetch them directly. A blanket disallow made a policy-abiding fetcher
// (Claude's own "open this link" step, not the MCP tool calls themselves,
// which aren't robots.txt-gated) refuse those URLs with a generic fetch
// failure, even though a human clicking the same link works fine — browsers
// don't consult robots.txt at all. Nothing under /api/files/** is indexable
// anyway: every URL is single-file and token-gated, so allowing it here
// doesn't reopen the catalog to search engines.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/api/files/",
      disallow: "/",
    },
  };
}
