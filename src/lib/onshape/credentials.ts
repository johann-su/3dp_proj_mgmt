import { eq } from "drizzle-orm";
import { db } from "@/db";
import { onshapeCredentials } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import type { OnshapeKeys } from "./api";

// Public (safe to send to the client) view of a connection.
export type OnshapeConnectionStatus = {
  connected: boolean;
  account?: string;
  accessKey?: string;
};

export async function getOnshapeCredential(
  userId: string,
): Promise<OnshapeKeys | null> {
  const row = await db.query.onshapeCredentials.findFirst({
    where: eq(onshapeCredentials.userId, userId),
  });
  if (!row) return null;
  try {
    return {
      accessKey: row.accessKey,
      secretKey: decryptSecret(row.secretKeyCipher),
    };
  } catch {
    // Ciphertext no longer decryptable (e.g. the app secret was rotated).
    return null;
  }
}

export async function getOnshapeStatus(
  userId: string,
): Promise<OnshapeConnectionStatus> {
  const row = await db.query.onshapeCredentials.findFirst({
    where: eq(onshapeCredentials.userId, userId),
    columns: { account: true, accessKey: true },
  });
  return row
    ? { connected: true, account: row.account, accessKey: row.accessKey }
    : { connected: false };
}

export async function saveOnshapeCredential(
  userId: string,
  account: string,
  keys: OnshapeKeys,
): Promise<void> {
  const secretKeyCipher = encryptSecret(keys.secretKey);
  await db
    .insert(onshapeCredentials)
    .values({ userId, account, accessKey: keys.accessKey, secretKeyCipher })
    .onConflictDoUpdate({
      target: onshapeCredentials.userId,
      set: { account, accessKey: keys.accessKey, secretKeyCipher, updatedAt: new Date() },
    });
}

export async function deleteOnshapeCredential(userId: string): Promise<void> {
  await db.delete(onshapeCredentials).where(eq(onshapeCredentials.userId, userId));
}
