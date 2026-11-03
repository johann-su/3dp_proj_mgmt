import { notFound, redirect } from "next/navigation";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { auth, getSession, mcpEnabled, signInRedirect } from "@/lib/auth";
import { resumeAuthorizeQuery, toSearchParams } from "@/lib/mcp/oauth-query";
import { McpProblem } from "../problem";

export const dynamic = "force-dynamic";

// The OAuth `loginPage`: where /api/auth/oauth2/authorize sends an MCP client's browser when the request has no session. Signing in happens on the normal /sign-in page — the proxy bounces a signed-out visitor there with this URL as the callback, so password and SSO logins both land back here — and this page then re-issues the original authorize request, which now finds the session and continues to /mcp/consent.
//
// Doing it this way keeps the sign-in forms unaware of OAuth (BetterAuth's alternative is a client plugin that rewrites every sign-in request), at the cost of honouring prompt=login/max_age only as far as "has a session".
export default async function McpAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!mcpEnabled) notFound();
  const session = await getSession();
  if (!session) redirect(await signInRedirect());

  const params = toSearchParams(await searchParams);
  // The signature proves the query came from our authorize endpoint, so this page can't be used to launder a hand-made request; it also expires.
  const { secret } = await auth.$context;
  if (!(await verifyOAuthQueryParams(params.toString(), secret))) {
    return (
      <McpProblem
        title="This connection link has expired"
        detail="Start connecting again from your MCP client."
      />
    );
  }
  redirect(`/api/auth/oauth2/authorize?${resumeAuthorizeQuery(params)}`);
}
