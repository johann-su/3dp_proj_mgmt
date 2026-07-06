import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getSessionInfo } from "@/lib/onshape/api";
import {
  appUrl,
  exchangeCode,
  OAUTH_STATE_COOKIE,
  onshapeOAuthEnabled,
} from "@/lib/onshape/oauth";
import { saveOnshapeCredential } from "@/lib/onshape/credentials";

export const runtime = "nodejs";

// OAuth redirect target (registered for the app at dev-portal.onshape.com).
// Verifies the CSRF state set by /api/onshape/authorize, exchanges the code
// for tokens and stores them encrypted for the signed-in user.
export async function GET(req: NextRequest) {
  const settings = (error?: string) => {
    const res = NextResponse.redirect(
      appUrl(`/settings/onshape${error ? `?error=${error}` : ""}`),
    );
    res.cookies.delete({ name: OAUTH_STATE_COOKIE, path: "/api/onshape" });
    return res;
  };

  const session = await getSession();
  if (!session) {
    return NextResponse.redirect(appUrl("/sign-in"));
  }
  if (!onshapeOAuthEnabled) {
    return settings("not-configured");
  }

  const params = req.nextUrl.searchParams;
  if (params.get("error")) {
    // The user cancelled on the consent screen.
    return settings("denied");
  }
  const code = params.get("code");
  const state = params.get("state");
  const expectedState = req.cookies.get(OAUTH_STATE_COOKIE)?.value;
  if (!code || !state || !expectedState || state !== expectedState) {
    return settings("state-mismatch");
  }

  try {
    const tokens = await exchangeCode(code);
    const info = await getSessionInfo({ accessToken: tokens.accessToken }).catch(
      () => null,
    );
    const account = info?.email || info?.name || "Onshape account";
    await saveOnshapeCredential(session.user.id, account, tokens);
    return settings();
  } catch (err) {
    console.error("Onshape OAuth callback failed", err);
    return settings("connect-failed");
  }
}
