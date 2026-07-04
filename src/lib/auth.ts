import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth } from "better-auth/plugins";
import { headers } from "next/headers";
import { db } from "@/db";
import * as schema from "@/db/schema";

// Optional OIDC single sign-on, enabled when all three env vars are set.
// The provider must allow the redirect URI:
//   {BETTER_AUTH_URL}/api/auth/oauth2/callback/oidc
const oidcIssuer = process.env.OIDC_ISSUER;
const oidcClientId = process.env.OIDC_CLIENT_ID;
const oidcClientSecret = process.env.OIDC_CLIENT_SECRET;

export const oidcEnabled = Boolean(oidcIssuer && oidcClientId && oidcClientSecret);
export const oidcProviderName = process.env.OIDC_PROVIDER_NAME || "SSO";

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
  plugins: oidcEnabled
    ? [
        genericOAuth({
          config: [
            {
              providerId: "oidc",
              clientId: oidcClientId!,
              clientSecret: oidcClientSecret!,
              discoveryUrl: `${oidcIssuer!.replace(/\/+$/, "")}/.well-known/openid-configuration`,
              scopes: ["openid", "profile", "email"],
            },
          ],
        }),
      ]
    : [],
});

export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}
