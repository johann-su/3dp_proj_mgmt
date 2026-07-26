// The app's public origin. Derived from BETTER_AUTH_URL rather than the
// incoming request: behind a reverse proxy `req.url` is the internal bind
// address (e.g. http://0.0.0.0:3000), so URLs built from it point at a host
// the client can't reach — which matters for every URL that leaves the app
// (OAuth redirect URIs, the links the MCP server hands to an LLM client).
export function appUrl(path: string): URL {
  const base = (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(
    /\/+$/,
    "",
  );
  return new URL(path, base);
}
