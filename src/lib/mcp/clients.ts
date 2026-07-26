// The user-facing side of the MCP OAuth tables (issue #96): which LLM clients
// a user has approved, and how to cut one off again.
//
// The tables themselves belong to BetterAuth's `mcp` plugin — this module only
// reads and deletes rows, never writes tokens. Grouping is by client, not by
// token row: re-approving the same client (or a refresh that rotates the pair)
// adds another row, and a person thinks in terms of "Claude is connected", not
// in terms of tokens.

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { oauthAccessToken, oauthConsent } from "@/db/schema";

export type McpClientConnection = {
  clientId: string;
  /** As the client registered itself; may be missing on a bare registration. */
  name: string | null;
  /** When this client was first approved. */
  connectedAt: Date;
  /** Newest token issued to it — a refresh moves this, so it reads as activity. */
  lastIssuedAt: Date;
  /** Whether any of its tokens is still valid; false = it must ask again. */
  active: boolean;
};

export async function listMcpClients(
  userId: string,
): Promise<McpClientConnection[]> {
  const tokens = await db.query.oauthAccessToken.findMany({
    where: eq(oauthAccessToken.userId, userId),
    columns: {
      clientId: true,
      createdAt: true,
      refreshTokenExpiresAt: true,
    },
    with: { client: { columns: { name: true } } },
  });

  const byClient = new Map<string, McpClientConnection>();
  for (const token of tokens) {
    const existing = byClient.get(token.clientId);
    // A refresh token still in date is what keeps a client working without the
    // user in the loop, so that — not the hour-long access token — is what
    // "still connected" means here.
    const active = token.refreshTokenExpiresAt > new Date();
    if (!existing) {
      byClient.set(token.clientId, {
        clientId: token.clientId,
        name: token.client?.name ?? null,
        connectedAt: token.createdAt,
        lastIssuedAt: token.createdAt,
        active,
      });
      continue;
    }
    if (token.createdAt < existing.connectedAt) existing.connectedAt = token.createdAt;
    if (token.createdAt > existing.lastIssuedAt) existing.lastIssuedAt = token.createdAt;
    existing.active ||= active;
  }

  return [...byClient.values()].sort(
    (a, b) => b.lastIssuedAt.getTime() - a.lastIssuedAt.getTime(),
  );
}

/**
 * Revokes one client's access for one user: every token it holds stops
 * working immediately (the MCP route resolves each request against these
 * rows), and any recorded consent goes with it so reconnecting asks again.
 *
 * The client's registration row is deliberately left alone — dynamic
 * registration is not per-user, so another user may still be connected
 * through it.
 */
export async function revokeMcpClient(
  userId: string,
  clientId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(oauthAccessToken)
      .where(
        and(
          eq(oauthAccessToken.userId, userId),
          eq(oauthAccessToken.clientId, clientId),
        ),
      );
    await tx
      .delete(oauthConsent)
      .where(
        and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)),
      );
  });
}
