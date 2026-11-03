"use server";

import { headers } from "next/headers";
import { auth, getSession, mcpEnabled } from "@/lib/auth";
import { logger } from "@/lib/logger";

/**
 * Answers the consent screen. BetterAuth checks the signed `oauthQuery` (it came from its own redirect to /mcp/consent), records the consent and returns where to send the browser: back to the client's redirect URI with an authorization code, or with `error=access_denied`. The browser follows it client-side — it is another origin, which the CSP's form-action 'self' would block as a form redirect.
 */
export async function answerConsent(input: {
  oauthQuery: string;
  accept: boolean;
}): Promise<{ url?: string; error?: string }> {
  if (!mcpEnabled) return { error: "The MCP server is disabled" };
  if (!(await getSession())) return { error: "You must be signed in" };
  try {
    const result = await auth.api.oauth2Consent({
      body: { accept: input.accept, oauth_query: input.oauthQuery },
      headers: await headers(),
    });
    return { url: result.url };
  } catch (err) {
    logger.warn({ err }, "[mcp] consent failed");
    return {
      error: "This request has expired — start connecting again from your MCP client.",
    };
  }
}
