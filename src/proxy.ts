import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

// Gate every page behind authentication: a request without a Better Auth
// session cookie is redirected to /sign-in. This is an optimistic cookie
// check (no DB round-trip) — pages and route handlers still call getSession()
// for the authoritative check, so a forged/expired cookie can't grant access.
//
// Note: in this Next.js version the middleware convention was renamed to
// `proxy` (see node_modules/next/dist/docs/.../proxy.md).

// Routes that must stay reachable while signed out.
const PUBLIC_PATHS = ["/sign-in", "/sign-up"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  if (!getSessionCookie(request)) {
    const signIn = new URL("/sign-in", request.url);
    return NextResponse.redirect(signIn);
  }

  return NextResponse.next();
}

export const config = {
  // Run on every path except API routes (they guard themselves), Next.js
  // internals, and static/metadata files.
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};
