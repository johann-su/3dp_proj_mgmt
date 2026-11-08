// The user-facing side of the MCP OAuth tables (issue #96): which LLM clients a user has approved, and how to cut one off again. The OAuth flow can only ever grant, so without this an approval would be permanent short of editing the database.
//
// The tables belong to the BetterAuth plugins (@better-auth/mcp on oauth-provider) — this module only reads and deletes rows, never writes tokens. Grouping is by client, not by token row: every refresh adds a row, and a person thinks "Claude is connected", not in tokens.

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { oauthAccessToken, oauthConsent, oauthRefreshToken } from "@/db/schema";

export type McpClientConnection = {
  clientId: string;
  /** As the client registered itself; may be missing on a bare registration. */
  name: string | null;
  /** When this client was first approved. */
  connectedAt: Date;
  /** Newest token issued to it — a refresh moves this, so it reads as activity. */
  lastIssuedAt: Date;
  /** A refresh token still in date; false = it must ask again. */
  active: boolean;
};

export async function listMcpClients(
  userId: string,
): Promise<McpClientConnection[]> {
  const [consents, tokens] = await Promise.all([
    db.query.oauthConsent.findMany({
      where: eq(oauthConsent.userId, userId),
      columns: { clientId: true, createdAt: true },
      with: { client: { columns: { name: true } } },
    }),
    db.query.oauthRefreshToken.findMany({
      where: eq(oauthRefreshToken.userId, userId),
      columns: { clientId: true, createdAt: true, expiresAt: true, revoked: true },
      with: { client: { columns: { name: true } } },
    }),
  ]);

  const now = new Date();
  const byClient = new Map<string, McpClientConnection>();
  const entry = (clientId: string, name: string | null | undefined, at: Date) => {
    let found = byClient.get(clientId);
    if (!found) {
      found = {
        clientId,
        name: name ?? null,
        connectedAt: at,
        lastIssuedAt: at,
        active: false,
      };
      byClient.set(clientId, found);
    }
    if (at < found.connectedAt) found.connectedAt = at;
    if (at > found.lastIssuedAt) found.lastIssuedAt = at;
    return found;
  };
  for (const consent of consents) {
    entry(consent.clientId, consent.client?.name, consent.createdAt);
  }
  // A refresh token still in date is what keeps a client working without the user in the loop, so that — not the 15-minute access token — is what "still connected" means here.
  for (const token of tokens) {
    const found = entry(token.clientId, token.client?.name, token.createdAt);
    found.active ||= !token.revoked && token.expiresAt > now;
  }

  return [...byClient.values()].sort(
    (a, b) => b.lastIssuedAt.getTime() - a.lastIssuedAt.getTime(),
  );
}

/**
 * Revokes one client's access for one user: its refresh tokens go (so it can't get new access tokens), and so does the consent, so reconnecting asks again. An access token already issued is a self-contained JWT and keeps working until it expires — at most accessTokenExpiresIn (15 min, see src/lib/auth.ts).
 *
 * The client's registration row is deliberately left alone — dynamic registration is not per-user, so another user may still be connected through it.
 */
export async function revokeMcpClient(
  userId: string,
  clientId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(oauthAccessToken)
      .where(
        and(eq(oauthAccessToken.userId, userId), eq(oauthAccessToken.clientId, clientId)),
      );
    await tx
      .delete(oauthRefreshToken)
      .where(
        and(eq(oauthRefreshToken.userId, userId), eq(oauthRefreshToken.clientId, clientId)),
      );
    await tx
      .delete(oauthConsent)
      .where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)));
  });
}
