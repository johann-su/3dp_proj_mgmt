import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  appUrl,
  buildAuthorizeUrl,
  OAUTH_STATE_COOKIE,
  onshapeOAuthEnabled,
} from "@/lib/onshape/oauth";

export const runtime = "nodejs";

// Starts the "Sign in with Onshape" flow: remembers a CSRF state in a cookie
// and sends the user to Onshape's consent screen. Onshape redirects back to
// /api/onshape/callback.
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.redirect(appUrl("/sign-in"));
  }
  if (!onshapeOAuthEnabled) {
    return NextResponse.redirect(appUrl("/settings/onshape?error=not-configured"));
  }

  const state = randomUUID();
  const res = NextResponse.redirect(buildAuthorizeUrl(state));
  res.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    // Based on the public origin, not the request: TLS is terminated at the
    // proxy so the internal request is plain http.
    secure: appUrl("/").protocol === "https:",
    path: "/api/onshape",
    maxAge: 600,
  });
  return res;
}
