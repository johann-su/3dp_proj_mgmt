import { NextResponse } from "next/server";
import { auth, mcpEnabled } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// RFC 9728 protected-resource metadata: "this resource is guarded by that
// authorization server". An MCP client reads it before its first authenticated
// call, so it must be reachable without a token (the proxy skips /.well-known).
//
// The optional catch-all serves it at both spellings a client may try: the
// RFC-derived location for our resource identifier
// (/.well-known/oauth-protected-resource/api/mcp) and the bare well-known path.
// BetterAuth serves a third copy under its own base path, which is the one its
// 401 `WWW-Authenticate: resource_metadata=…` header points at; all three
// return the same document, so whichever a client picks agrees with the others.
export async function GET() {
  if (!mcpEnabled) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const metadata = await auth.api.getMCPProtectedResource();
  return NextResponse.json(metadata, {
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}
