import { NextResponse } from "next/server";
import { auth, mcpEnabled } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// RFC 9728 protected-resource metadata: "/api/mcp is guarded by that
// authorization server". A client reads it — from the URL in the 401's
// `WWW-Authenticate` header, /.well-known/oauth-protected-resource/api/mcp —
// before it holds any credential, so the proxy skips /.well-known.
//
// The @better-auth/mcp plugin builds this document in its request hook, which
// only sees requests routed through the BetterAuth handler; forwarding the
// request unchanged lets it answer at the path it expects.
export async function GET(request: Request) {
  if (!mcpEnabled) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return auth.handler(request);
}

export const HEAD = GET;
