import { NextResponse } from "next/server";
import { auth, oidcEnabled } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The OIDC redirect URI operators registered at their IdP before BetterAuth 1.7: {BETTER_AUTH_URL}/api/auth/oauth2/callback/oidc. 1.7 serves generic OAuth providers on the core /api/auth/callback/<id> route instead (see OIDC_REDIRECT_PATH in src/lib/auth.ts). The provider is configured to keep sending this URL as its redirect_uri — so the authorize request and the code exchange still agree with what the IdP has on file — and this route hands the IdP's redirect to the new handler unchanged (query, cookies, and the form_post body if the IdP uses one).
//
// More specific than the /api/auth/[...all] catch-all, so it wins for this path only. Only the "oidc" provider ever lived here.
async function forward(
  request: Request,
  { params }: { params: Promise<{ providerId: string }> },
) {
  const { providerId } = await params;
  if (!oidcEnabled || providerId !== "oidc") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const url = new URL(request.url);
  url.pathname = `/api/auth/callback/${providerId}`;
  return auth.handler(new Request(url, request));
}

export const GET = forward;
export const POST = forward;
