import nextra from "nextra";

// Standalone operator-docs site (issue #72). Content is NOT authored here:
// Nextra discovers its pages in ./content, which is a symlink to the top-level
// docs/ directory (the location is not configurable — Nextra globs for
// `{src/,}content` relative to this app). Keeping the pages in docs/ lets a
// feature PR update its docs in the same commit.
const withNextra = nextra({});

export default withNextra({
  // Static export: the site is plain HTML, served by ./Dockerfile's nginx (or
  // any static host) on its own subdomain — never bundled into the app image.
  output: "export",
  // Two lockfiles live in this repo (app + this package); without this Next
  // would guess the workspace root and warn.
  outputFileTracingRoot: import.meta.dirname,
  // Directory-per-page output so a dumb static server resolves /self-hosting/
  // without rewrite rules.
  trailingSlash: true,
  // next/image optimization needs a server; required with output: "export".
  images: { unoptimized: true },
});
