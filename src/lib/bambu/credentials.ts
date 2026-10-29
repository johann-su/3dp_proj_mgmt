import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bambuCredentials } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import type { BambuRegion } from "./cloud";
import {
  bambuTokenHealth,
  resolveTokenExpiry,
  type BambuTokenState,
} from "./token-expiry";

export type BambuCredential = {
  account: string;
  region: BambuRegion;
  token: string;
};

// Public (safe to send to the client) view of a connection.
export type BambuConnectionStatus = {
  connected: boolean;
  account?: string;
  region?: BambuRegion;
  // Renewal reminder inputs — see src/lib/bambu/token-expiry.ts.
  state?: BambuTokenState;
  expiresAt?: string | null; // ISO
  daysLeft?: number | null;
};

export async function getBambuCredential(
  userId: string,
): Promise<BambuCredential | null> {
  const row = await db.query.bambuCredentials.findFirst({
    where: eq(bambuCredentials.userId, userId),
  });
  if (!row) return null;
  try {
    return {
      account: row.account,
      region: row.region,
      token: decryptSecret(row.tokenCipher),
    };
  } catch {
    // Ciphertext no longer decryptable (e.g. the app secret was rotated).
    return null;
  }
}

export async function getBambuStatus(
  userId: string,
): Promise<BambuConnectionStatus> {
  const row = await db.query.bambuCredentials.findFirst({
    where: eq(bambuCredentials.userId, userId),
    columns: { account: true, region: true, expiresAt: true, invalidAt: true },
  });
  if (!row) return { connected: false };
  const health = bambuTokenHealth(row.expiresAt, row.invalidAt);
  return {
    connected: true,
    account: row.account,
    region: row.region,
    state: health.state,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    daysLeft: health.daysLeft,
  };
}

// `expiresIn` is the login response's token lifetime in seconds, when Bambu
// sent one. Saving always clears a previous "rejected" mark — it's a new token.
export async function saveBambuCredential(
  userId: string,
  account: string,
  region: BambuRegion,
  token: string,
  expiresIn?: number,
): Promise<void> {
  const tokenCipher = encryptSecret(token);
  const expiresAt = resolveTokenExpiry(token, expiresIn);
  await db
    .insert(bambuCredentials)
    .values({ userId, account, region, tokenCipher, expiresAt })
    .onConflictDoUpdate({
      target: bambuCredentials.userId,
      set: {
        account,
        region,
        tokenCipher,
        expiresAt,
        invalidAt: null,
        updatedAt: new Date(),
      },
    });
}

// Called when Bambu answered 401/403 for the stored token, so the settings
// page and the header reminder ask the user to renew. The credential is kept
// (not deleted) so renewing can prefill the account and region.
export async function markBambuCredentialInvalid(userId: string): Promise<void> {
  await db
    .update(bambuCredentials)
    .set({ invalidAt: new Date() })
    .where(eq(bambuCredentials.userId, userId));
}

export async function deleteBambuCredential(userId: string): Promise<void> {
  await db.delete(bambuCredentials).where(eq(bambuCredentials.userId, userId));
}
