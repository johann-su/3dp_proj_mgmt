// When a stored Bambu Cloud token stops working, and how close that is.
//
// Bambu tokens can't be renewed silently: the community-documented
// `/v1/user-service/user/refreshtoken` endpoint answers only 401 nowadays
// (OpenBambuAPI, cloud-http.md), and the refresh token it hands out equals
// the access token anyway. So "renewing" means logging in again — this module
// only tells the UI when to ask for that.

// Start reminding the user this many days before the token expires.
export const EXPIRY_WARNING_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

// `exp` claim of a JWT-shaped token (pasted MakerWorld cookies are JWTs), or
// null when the token isn't a decodable JWT or carries no expiry.
export function jwtExpiry(token: string): Date | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as { exp?: unknown };
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
      return null;
    }
    return new Date(payload.exp * 1000);
  } catch {
    return null;
  }
}

// Expiry of a freshly obtained token: the login response's `expiresIn`
// (seconds, ~90 days) wins; otherwise the token's own JWT claim; otherwise
// unknown (null) — never a guess, so the UI doesn't nag on a made-up date.
export function resolveTokenExpiry(
  token: string,
  expiresIn: number | undefined,
  now: Date = new Date(),
): Date | null {
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) {
    return new Date(now.getTime() + expiresIn * 1000);
  }
  return jwtExpiry(token);
}

export type BambuTokenState = "valid" | "expiring" | "expired";

export type BambuTokenHealth = {
  state: BambuTokenState;
  // Whole days until expiry (0 on the last day); null when unknown or past.
  daysLeft: number | null;
};

// `invalidAt` is set when Bambu actually rejected the token (a 401 during an
// import/sync) — that beats any expiry date, which may be wrong.
export function bambuTokenHealth(
  expiresAt: Date | null,
  invalidAt: Date | null,
  now: Date = new Date(),
): BambuTokenHealth {
  if (invalidAt) return { state: "expired", daysLeft: null };
  if (!expiresAt) return { state: "valid", daysLeft: null };
  const msLeft = expiresAt.getTime() - now.getTime();
  if (msLeft <= 0) return { state: "expired", daysLeft: null };
  const daysLeft = Math.floor(msLeft / DAY_MS);
  return {
    state: daysLeft < EXPIRY_WARNING_DAYS ? "expiring" : "valid",
    daysLeft,
  };
}

// "in 3 days" phrasing for the reminder; daysLeft 0 is the last day.
export function formatDaysLeft(daysLeft: number): string {
  if (daysLeft <= 0) return "less than a day";
  return daysLeft === 1 ? "1 day" : `${daysLeft} days`;
}
