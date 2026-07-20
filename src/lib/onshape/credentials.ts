import { eq } from "drizzle-orm";
import { db } from "@/db";
import { onshapeCredentials } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { refreshTokens, type OnshapeTokens } from "./oauth";

// Public (safe to send to the client) view of a connection.
export type OnshapeConnectionStatus = {
  connected: boolean;
  account?: string;
};

export async function getOnshapeStatus(
  userId: string,
): Promise<OnshapeConnectionStatus> {
  const row = await db.query.onshapeCredentials.findFirst({
    where: eq(onshapeCredentials.userId, userId),
    columns: { account: true },
  });
  return row ? { connected: true, account: row.account } : { connected: false };
}

export async function saveOnshapeCredential(
  userId: string,
  account: string,
  tokens: OnshapeTokens,
): Promise<void> {
  const values = {
    account,
    accessTokenCipher: encryptSecret(tokens.accessToken),
    refreshTokenCipher: encryptSecret(tokens.refreshToken),
    accessTokenExpiresAt: tokens.expiresAt,
  };
  await db
    .insert(onshapeCredentials)
    .values({ userId, ...values })
    .onConflictDoUpdate({
      target: onshapeCredentials.userId,
      set: { ...values, updatedAt: new Date() },
    });
}

export async function deleteOnshapeCredential(userId: string): Promise<void> {
  await db.delete(onshapeCredentials).where(eq(onshapeCredentials.userId, userId));
}

// Returns a valid access token for the user, transparently refreshing an
// expired one (Onshape access tokens live ~60 min; refresh tokens are rotated
// and persisted on every refresh). Returns null when there is no connection
// or it can no longer be refreshed (revoked in Onshape, rotated app secret) —
// the user then reconnects in Settings → Onshape.
//
// Rotation makes refreshing racy: when two requests hit an expired token at
// once, both send the same refresh token, Onshape accepts one and rejects the
// other — and dropping the connection on that rejection would wipe the fresh
// tokens the winner just saved. So a failed refresh only deletes the
// credential if the stored refresh token is still the one that failed; if it
// changed, another request rotated it and the loop re-reads the fresh row.
export async function getOnshapeAccessToken(userId: string): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await db.query.onshapeCredentials.findFirst({
      where: eq(onshapeCredentials.userId, userId),
    });
    if (!row) return null;

    let accessToken: string;
    let refreshToken: string;
    try {
      accessToken = decryptSecret(row.accessTokenCipher);
      refreshToken = decryptSecret(row.refreshTokenCipher);
    } catch {
      // Ciphertext no longer decryptable (e.g. the app secret was rotated).
      return null;
    }

    if (row.accessTokenExpiresAt.getTime() > Date.now()) {
      return accessToken;
    }

    try {
      const fresh = await refreshTokens(refreshToken);
      await saveOnshapeCredential(userId, row.account, fresh);
      return fresh.accessToken;
    } catch {
      if (await wasTokenRotated(userId, refreshToken)) {
        continue; // lost the rotation race — pick up the winner's tokens
      }
      // Refresh token revoked or rejected — drop the dead connection so the
      // settings page shows "Connect" again instead of a broken state.
      await deleteOnshapeCredential(userId);
      return null;
    }
  }
  return null;
}

// True when the stored refresh token no longer matches the one a failed
// refresh used — i.e. a concurrent request already rotated the tokens.
async function wasTokenRotated(userId: string, usedRefreshToken: string): Promise<boolean> {
  const row = await db.query.onshapeCredentials.findFirst({
    where: eq(onshapeCredentials.userId, userId),
  });
  if (!row) return false;
  try {
    return decryptSecret(row.refreshTokenCipher) !== usedRefreshToken;
  } catch {
    return false;
  }
}
