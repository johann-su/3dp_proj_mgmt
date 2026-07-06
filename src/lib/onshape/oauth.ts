// Onshape OAuth2 (authorization-code flow), the auth used by third-party
// Onshape apps (see github.com/onshape/passport-onshape — this implements the
// same endpoints without the Express middleware). The self-hoster registers
// an OAuth app once at dev-portal.onshape.com with the redirect URI
// {BETTER_AUTH_URL}/api/onshape/callback and sets ONSHAPE_CLIENT_ID/SECRET;
// users then connect per-account with a consent screen instead of API keys.
//
// Access tokens live ~60 minutes; refresh tokens are rotated on every refresh
// and both are stored encrypted (src/lib/onshape/credentials.ts).

const OAUTH_BASE = "https://oauth.onshape.com/oauth";

const clientId = process.env.ONSHAPE_CLIENT_ID?.trim();
const clientSecret = process.env.ONSHAPE_CLIENT_SECRET?.trim();

export const onshapeOAuthEnabled = Boolean(clientId && clientSecret);

// CSRF state cookie shared by the authorize and callback routes.
export const OAUTH_STATE_COOKIE = "onshape-oauth-state";

// The app's public origin. Derived from BETTER_AUTH_URL rather than the
// incoming request: behind a reverse proxy `req.url` is the internal bind
// address (e.g. http://0.0.0.0:3000), so redirects built from it send the
// browser to a host it can't reach.
export function appUrl(path: string): URL {
  const base = (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(
    /\/+$/,
    "",
  );
  return new URL(path, base);
}

export function onshapeRedirectUri(): string {
  return appUrl("/api/onshape/callback").toString();
}

export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId!,
    redirect_uri: onshapeRedirectUri(),
    state,
  });
  return `${OAUTH_BASE}/authorize?${params}`;
}

export type OnshapeTokens = {
  accessToken: string;
  refreshToken: string;
  // Absolute expiry, with a safety margin subtracted.
  expiresAt: Date;
};

export class OnshapeOAuthError extends Error {}

// Refresh slightly early so a token never expires mid-import.
const EXPIRY_MARGIN_MS = 60_000;

async function tokenRequest(body: URLSearchParams): Promise<OnshapeTokens> {
  const res = await fetch(`${OAUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  } | null;
  if (!res.ok || !json?.access_token || !json.refresh_token) {
    throw new OnshapeOAuthError(
      `Onshape token request failed (${json?.error ?? res.status})`,
    );
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: new Date(
      Date.now() + (json.expires_in ?? 3600) * 1000 - EXPIRY_MARGIN_MS,
    ),
  };
}

export async function exchangeCode(code: string): Promise<OnshapeTokens> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId!,
      client_secret: clientSecret!,
      redirect_uri: onshapeRedirectUri(),
    }),
  );
}

export async function refreshTokens(refreshToken: string): Promise<OnshapeTokens> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId!,
      client_secret: clientSecret!,
    }),
  );
}
