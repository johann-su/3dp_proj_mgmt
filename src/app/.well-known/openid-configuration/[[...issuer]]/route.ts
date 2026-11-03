import { NextResponse } from "next/server";
import { oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { auth, mcpEnabled } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// OpenID discovery for the same issuer as oauth-authorization-server (see
// there). Some MCP clients look for this spelling first.
const metadata = oauthProviderOpenIdConfigMetadata(auth);

export async function GET(request: Request) {
  if (!mcpEnabled) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return metadata(request);
}
