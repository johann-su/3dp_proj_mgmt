// Minimal client for the (unofficial, reverse-engineered) Bambu Cloud API.
//
// Only what this app needs: log a user in to obtain an access token, and
// exchange a MakerWorld print-profile id for a short-lived presigned download
// URL. The same token doubles as the MakerWorld download credential — see
// src/lib/import/makerworld.ts.
//
// Endpoints and flow are community-documented; Bambu can change them at will.

export type BambuRegion = "global" | "china";

// A realistic desktop UA — some Bambu endpoints reject obvious bots.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export function apiBase(region: BambuRegion): string {
  return region === "china"
    ? "https://api.bambulab.cn"
    : "https://api.bambulab.com";
}

function webBase(region: BambuRegion): string {
  return region === "china" ? "https://bambulab.cn" : "https://bambulab.com";
}

function jsonHeaders() {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
}

// Result of an initial email/password login attempt.
export type LoginResult =
  | { status: "success"; accessToken: string }
  | { status: "needCode" } // an email verification code was sent
  | { status: "needTfa"; tfaKey: string } // authenticator-app code required
  | { status: "error"; message: string };

type LoginResponse = {
  success?: boolean;
  accessToken?: string;
  loginType?: string;
  tfaKey?: string;
  code?: number;
  error?: string;
  message?: string;
};

async function postLogin(
  region: BambuRegion,
  body: Record<string, unknown>,
): Promise<LoginResponse> {
  const res = await fetch(`${apiBase(region)}/v1/user-service/user/login`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as LoginResponse;
  if (!res.ok && !data.loginType && !data.accessToken) {
    throw new Error(
      data.error || data.message || `Bambu login failed (${res.status})`,
    );
  }
  return data;
}

export async function bambuLogin(
  account: string,
  password: string,
  region: BambuRegion,
): Promise<LoginResult> {
  const data = await postLogin(region, { account, password, apiError: "" });

  if (data.accessToken) {
    return { status: "success", accessToken: data.accessToken };
  }
  if (data.loginType === "verifyCode") {
    await sendEmailCode(account, region);
    return { status: "needCode" };
  }
  if (data.loginType === "tfa" && data.tfaKey) {
    return { status: "needTfa", tfaKey: data.tfaKey };
  }
  return {
    status: "error",
    message: data.error || data.message || "Incorrect email or password",
  };
}

export async function sendEmailCode(
  account: string,
  region: BambuRegion,
): Promise<void> {
  await fetch(`${apiBase(region)}/v1/user-service/user/sendemail/code`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ email: account, type: "codeLogin" }),
  });
}

export async function bambuLoginWithCode(
  account: string,
  code: string,
  region: BambuRegion,
): Promise<string> {
  const data = await postLogin(region, { account, code });
  if (!data.accessToken) {
    throw new Error(data.error || data.message || "Invalid verification code");
  }
  return data.accessToken;
}

// Authenticator-app (TOTP) step. The token is returned in a `token` cookie on
// the web host rather than in the JSON body.
export async function bambuVerifyTfa(
  tfaKey: string,
  tfaCode: string,
  region: BambuRegion,
): Promise<string> {
  const res = await fetch(`${webBase(region)}/api/sign-in/tfa`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ tfaKey, tfaCode }),
    redirect: "manual",
  });

  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/(?:^|[;,\s])token=([^;]+)/);
  if (match) return decodeURIComponent(match[1]);

  const data = (await res.json().catch(() => ({}))) as LoginResponse & {
    token?: string;
  };
  const token = data.accessToken || data.token;
  if (!token) {
    throw new Error(data.error || data.message || "Invalid authenticator code");
  }
  return token;
}

// Best-effort token check: 401 means the token is invalid/expired; anything
// else is treated as usable (endpoints vary, and we don't want false negatives
// blocking a token that will work for downloads).
export async function validateToken(
  token: string,
  region: BambuRegion,
): Promise<boolean> {
  try {
    const res = await fetch(
      `${apiBase(region)}/v1/user-service/my/preference`,
      { headers: { ...jsonHeaders(), Authorization: `Bearer ${token}` } },
    );
    return res.status !== 401;
  } catch {
    return true;
  }
}

export type ProfileDownload = { url: string; name: string };

// Exchanges a design's print-profile id for a short-lived (~5 min) presigned
// download URL. Returns null on a 401 so the caller can prompt a reconnect.
export async function fetchProfileDownload(
  profileId: number,
  modelId: string,
  token: string,
  region: BambuRegion,
): Promise<ProfileDownload | null | "unauthorized"> {
  const res = await fetch(
    `${apiBase(region)}/v1/iot-service/api/user/profile/${profileId}?model_id=${encodeURIComponent(modelId)}`,
    { headers: { ...jsonHeaders(), Authorization: `Bearer ${token}` } },
  );
  if (res.status === 401) return "unauthorized";
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as {
    url?: string;
    name?: string;
  } | null;
  if (!data?.url) return null;
  return { url: data.url, name: data.name ?? "" };
}

// Exchanges a design id for a presigned download of its *raw* model files
// (the "raw model files" panel on MakerWorld — .scad sources, unsliced
// .3mf/.stl geometry — as opposed to the sliced print profiles above). Only
// `modelType=all` works (verified against a live account: "scad"/"3mf"
// answer 404), returning one zip of every raw file with an empty `name`.
// Undocumented like the favorites API: discovered from community clients of
// MakerWorld's own frontend, so Bambu can change it at will. Requires a
// login — it answers 403 "Please log in to download models." anonymously,
// hence 403 also maps to "unauthorized".
export async function fetchRawModelDownload(
  designId: number,
  modelType: string,
  token: string,
  region: BambuRegion,
): Promise<ProfileDownload | null | "unauthorized"> {
  const res = await fetch(
    `${apiBase(region)}/v1/design-service/design/${designId}/model?modelType=${encodeURIComponent(modelType)}&type=download`,
    { headers: { ...jsonHeaders(), Authorization: `Bearer ${token}` } },
  );
  if (res.status === 401 || res.status === 403) return "unauthorized";
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as {
    url?: string;
    name?: string;
  } | null;
  if (!data?.url) return null;
  return { url: data.url, name: data.name ?? "" };
}
