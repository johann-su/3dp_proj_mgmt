import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bambuCredentials } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import type { BambuRegion } from "./cloud";

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
    columns: { account: true, region: true },
  });
  return row
    ? { connected: true, account: row.account, region: row.region }
    : { connected: false };
}

export async function saveBambuCredential(
  userId: string,
  account: string,
  region: BambuRegion,
  token: string,
): Promise<void> {
  const tokenCipher = encryptSecret(token);
  await db
    .insert(bambuCredentials)
    .values({ userId, account, region, tokenCipher })
    .onConflictDoUpdate({
      target: bambuCredentials.userId,
      set: { account, region, tokenCipher, updatedAt: new Date() },
    });
}

export async function deleteBambuCredential(userId: string): Promise<void> {
  await db.delete(bambuCredentials).where(eq(bambuCredentials.userId, userId));
}
