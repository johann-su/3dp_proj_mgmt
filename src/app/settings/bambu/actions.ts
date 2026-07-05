"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth";
import {
  bambuLogin,
  bambuLoginWithCode,
  bambuVerifyTfa,
  validateToken,
  type BambuRegion,
} from "@/lib/bambu/cloud";
import {
  deleteBambuCredential,
  saveBambuCredential,
} from "@/lib/bambu/credentials";

function normalizeRegion(region: string): BambuRegion {
  return region === "china" ? "china" : "global";
}

// Step 1 of the login flow. Depending on the account's security settings this
// either connects immediately, or asks the client for an email code / TOTP.
export type StartLoginResult =
  | { status: "connected" }
  | { status: "needCode" }
  | { status: "needTfa"; tfaKey: string }
  | { error: string };

export async function startBambuLogin(input: {
  account: string;
  password: string;
  region: string;
}): Promise<StartLoginResult> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };

  const account = input.account.trim();
  if (!account || !input.password) {
    return { error: "Enter your Bambu account email and password" };
  }
  const region = normalizeRegion(input.region);

  try {
    const result = await bambuLogin(account, input.password, region);
    if (result.status === "success") {
      await saveBambuCredential(session.user.id, account, region, result.accessToken);
      revalidatePath("/settings/bambu");
      return { status: "connected" };
    }
    if (result.status === "needCode") return { status: "needCode" };
    if (result.status === "needTfa") return { status: "needTfa", tfaKey: result.tfaKey };
    return { error: result.message };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Bambu login failed" };
  }
}

export async function finishBambuCode(input: {
  account: string;
  code: string;
  region: string;
}): Promise<{ status: "connected" } | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };

  const account = input.account.trim();
  const code = input.code.trim();
  if (!account || !code) return { error: "Enter the verification code" };
  const region = normalizeRegion(input.region);

  try {
    const token = await bambuLoginWithCode(account, code, region);
    await saveBambuCredential(session.user.id, account, region, token);
    revalidatePath("/settings/bambu");
    return { status: "connected" };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Verification failed" };
  }
}

export async function finishBambuTfa(input: {
  account: string;
  tfaKey: string;
  tfaCode: string;
  region: string;
}): Promise<{ status: "connected" } | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };

  const account = input.account.trim();
  const tfaCode = input.tfaCode.trim();
  if (!input.tfaKey || !tfaCode) return { error: "Enter the authenticator code" };
  const region = normalizeRegion(input.region);

  try {
    const token = await bambuVerifyTfa(input.tfaKey, tfaCode, region);
    await saveBambuCredential(session.user.id, account, region, token);
    revalidatePath("/settings/bambu");
    return { status: "connected" };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Verification failed" };
  }
}

// Alternative to logging in: paste the `token` cookie from a signed-in
// MakerWorld browser session.
export async function saveBambuToken(input: {
  account: string;
  token: string;
  region: string;
}): Promise<{ status: "connected" } | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };

  const account = input.account.trim();
  const token = input.token.trim();
  if (!account || !token) return { error: "Enter your Bambu email and token" };
  const region = normalizeRegion(input.region);

  const ok = await validateToken(token, region);
  if (!ok) return { error: "That token was rejected by Bambu (expired or invalid)" };

  await saveBambuCredential(session.user.id, account, region, token);
  revalidatePath("/settings/bambu");
  return { status: "connected" };
}

export async function disconnectBambu(): Promise<{ error: string } | void> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };
  await deleteBambuCredential(session.user.id);
  revalidatePath("/settings/bambu");
}
