import { NextResponse } from "next/server";
import { auth, mcpEnabled, MCP_AUTHORIZE_PATH } from "@/lib/auth";
import { appUrl } from "@/lib/app-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// RFC 8414 authorization-server metadata, the document an MCP client reads to
// learn where to register, authorize and get tokens. It lives at the *origin*
// root because that is the issuer BetterAuth advertises in the protected-
// resource metadata (`authorization_servers: [origin]`), not under /api/auth.
//
// One field is deliberately not BetterAuth's: `authorization_endpoint` points
// at our own consent page (src/app/mcp/authorize/page.tsx) instead of
// /api/auth/mcp/authorize. That page shows the user which client is asking
// before anything is granted, and — because it only forwards to BetterAuth
// once a session exists — keeps the plugin's "no session → stash the request
// in a cookie and resume it after the next sign-in" path out of the picture.
// That path replies to the *fetch* the sign-in form makes with a cross-origin
// 302, which the browser follows and the form reads as a failed sign-in.
export async function GET() {
  if (!mcpEnabled) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const metadata = await auth.api.getMcpOAuthConfig();
  return NextResponse.json(
    { ...metadata, authorization_endpoint: appUrl(MCP_AUTHORIZE_PATH).toString() },
    // Public, unauthenticated metadata — clients read it before they hold any
    // credential, and read it from a different origin.
    { headers: { "Access-Control-Allow-Origin": "*" } },
  );
}
