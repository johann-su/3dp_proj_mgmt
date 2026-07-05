import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  buildAuthorizeUrl,
  OAUTH_STATE_COOKIE,
  onshapeOAuthEnabled,
} from "@/lib/onshape/oauth";

export const runtime = "nodejs";

// Starts the "Sign in with Onshape" flow: remembers a CSRF state in a cookie
// and sends the user to Onshape's consent screen. Onshape redirects back to
// /api/onshape/callback.
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.redirect(new URL("/sign-in", req.url));
  }
  if (!onshapeOAuthEnabled) {
    return NextResponse.redirect(
      new URL("/settings/onshape?error=not-configured", req.url),
    );
  }

  const state = randomUUID();
  const res = NextResponse.redirect(buildAuthorizeUrl(state));
  res.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.nextUrl.protocol === "https:",
    path: "/api/onshape",
    maxAge: 600,
  });
  return res;
}
