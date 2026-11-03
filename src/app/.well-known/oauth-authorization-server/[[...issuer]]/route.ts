import { NextResponse } from "next/server";
import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { auth, mcpEnabled } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// RFC 8414 authorization-server metadata — where an MCP client learns to register, authorize and fetch tokens. The issuer is {origin}/api/auth (the BetterAuth base path), and RFC 8414 puts its metadata at the *origin* root with the issuer path appended (/.well-known/oauth-authorization-server/api/auth), which the catch-all serves; the bare spelling is answered too for clients that try it. Both are outside /api/auth, hence this route. The proxy skips
// /.well-known: a client reads this before it holds any credential.
const metadata = oauthProviderAuthServerMetadata(auth);

export async function GET(request: Request) {
  if (!mcpEnabled) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return metadata(request);
}
