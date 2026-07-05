import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth } from "better-auth/plugins";
import { headers } from "next/headers";
import { db } from "@/db";
import * as schema from "@/db/schema";

// Optional OIDC single sign-on, enabled when all three env vars are set.
// The provider must allow the redirect URI:
//   {BETTER_AUTH_URL}/api/auth/oauth2/callback/oidc
//
// OIDC_ISSUER accepts either the issuer base URL or a full discovery URL.
// Note for Authentik: issuers are per application —
//   https://<host>/application/o/<app-slug>/
// the domain root does NOT serve /.well-known/openid-configuration.
const oidcIssuer = process.env.OIDC_ISSUER?.trim();
const oidcClientId = process.env.OIDC_CLIENT_ID?.trim();
const oidcClientSecret = process.env.OIDC_CLIENT_SECRET?.trim();

export const oidcEnabled = Boolean(oidcIssuer && oidcClientId && oidcClientSecret);
export const oidcProviderName = process.env.OIDC_PROVIDER_NAME?.trim() || "SSO";

const discoveryUrl = oidcIssuer?.includes("/.well-known/")
  ? oidcIssuer
  : `${oidcIssuer?.replace(/\/+$/, "")}/.well-known/openid-configuration`;

// Validate the discovery endpoint once at boot so a wrong issuer shows up in
// the server log with an actionable message instead of only surfacing as
// INVALID_OAUTH_CONFIGURATION at sign-in time.
if (oidcEnabled && process.env.NEXT_PHASE !== "phase-production-build") {
  fetch(discoveryUrl)
    .then(async (res) => {
      const doc = res.ok ? await res.json().catch(() => null) : null;
      if (!res.ok || !doc?.authorization_endpoint) {
        console.error(
          `[oidc] discovery failed at ${discoveryUrl} (status ${res.status}). ` +
            "Check OIDC_ISSUER — for Authentik it must be the application issuer, " +
            "e.g. https://<host>/application/o/<app-slug>/",
        );
      } else {
        console.log(`[oidc] SSO enabled, issuer ${doc.issuer ?? discoveryUrl}`);
      }
    })
    .catch((err: unknown) => {
      console.error(
        `[oidc] could not reach ${discoveryUrl}: ${err instanceof Error ? err.message : err}`,
      );
    });
}

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  emailAndPassword: {
    enabled: true,
  },
  account: {
    accountLinking: {
      enabled: true,
      // Let an SSO login attach to an existing email/password account with
      // the same email instead of failing with account_not_linked.
      trustedProviders: ["oidc"],
      // Local accounts are never email-verified (we send no verification
      // mails), so don't require that for linking. The IdP asserts the email.
      requireLocalEmailVerified: false,
    },
  },
  plugins: oidcEnabled
    ? [
        genericOAuth({
          config: [
            {
              providerId: "oidc",
              clientId: oidcClientId!,
              clientSecret: oidcClientSecret!,
              discoveryUrl,
              scopes: ["openid", "profile", "email"],
              // Users that don't exist yet are created on first SSO login
              // (implicit sign-up is the default; spelled out here on purpose).
              disableImplicitSignUp: false,
              mapProfileToUser: (profile) => ({
                name:
                  profile.name ||
                  profile.preferred_username ||
                  (typeof profile.email === "string"
                    ? profile.email.split("@")[0]
                    : "User"),
              }),
            },
          ],
        }),
      ]
    : [],
});

export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}
