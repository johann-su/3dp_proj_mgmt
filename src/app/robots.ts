import type { MetadataRoute } from "next";

// The catalog is private (auth is the only real gate), but there's no reason
// to also let it get indexed and surfaced in search results for anyone who
// isn't already looking for it.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      disallow: "/",
    },
  };
}
