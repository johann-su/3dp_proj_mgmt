import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth, jwt } from "better-auth/plugins";
import { mcp } from "@better-auth/mcp";
import { apiKey } from "@better-auth/api-key";
import { headers } from "next/headers";
import { and, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { appUrl } from "@/lib/app-url";
import { logger } from "@/lib/logger";
import { roleFromOidcGroups, type UserRole } from "@/lib/roles";
import { envFlag, passwordLoginEnabled } from "@/lib/auth-config";
import { API_KEY_PREFIX } from "@/lib/api/scopes";
import { CALLBACK_PATH_HEADER, signInPath } from "@/lib/callback-url";

// Optional OIDC single sign-on, enabled when all three env vars are set.
// The provider must allow the redirect URI:
//   {BETTER_AUTH_URL}/api/auth/oauth2/callback/oidc
//
// That is the generic-oauth plugin's pre-1.7 callback path. BetterAuth 1.7 moved generic providers onto the core /callback/<id> route; we keep advertising the old URL (OIDC_REDIRECT_PATH below) and forward it to the new handler (src/app/api/auth/oauth2/callback/[providerId]/route.ts), so an upgrade doesn't require re-registering the redirect URI at the IdP — which, with DISABLE_PASSWORD_LOGIN set, would otherwise lock everyone out.
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
export const OIDC_REDIRECT_PATH = "/api/auth/oauth2/callback/oidc";

// Optional IdP-group → role mapping (issue #54): the exact group names, as the IdP spells them in the OIDC `groups` claim (Authentik includes it with the standard `profile` scope). While configured, group membership is authoritative on every SSO login — joining the group grants the role, leaving it revokes it — so manage SSO users' roles in the IdP, not on Settings → Users. See roleFromOidcGroups in src/lib/roles.ts.
const oidcAdminGroup = process.env.OIDC_ADMIN_GROUP?.trim() || null;
const oidcModeratorGroup = process.env.OIDC_MODERATOR_GROUP?.trim() || null;

// BetterAuth rate-limits auth endpoints by client IP whenever NODE_ENV is "production" (true for the Docker image), with a tight built-in rule for sign-in/sign-up/change-password/change-email (3 requests/10s). It reads that IP from X-Forwarded-For (getIPFromHeader in @better-auth/core/utils/ip):
//
//  * a SINGLE-value header is trusted as-is — no configuration needed, which
//    is the common case behind one proxy that *replaces* the header (Traefik
//    with no forwardedHeaders.trustedIPs discards whatever the client sent,
//    and does not append its own hop — measured, not assumed);
//  * a MULTI-value header is refused outright unless trustedProxies is set, so
//    every signed-out visitor collapses onto one shared bucket and one
//    person's failed sign-in can lock out everyone else for the window. That
//    is what a chain that appends (nginx's $proxy_add_x_forwarded_for, a CDN
//    in front of your proxy) produces, and what TRUSTED_PROXY_CIDRS fixes: the
//    listed hops are stripped from the right until an untrusted one is left.
//
// The entries match values *inside the header*, never the peer address — so setting this when the header is already single-valued is actively harmful: a CIDR covering your real clients (10.0.0.0/8 on a VPN) marks the only entry as a proxy, leaves nothing untrusted, and yields the shared bucket it was meant to prevent. Leave it unset until you've looked at the header the app actually receives. Malformed entries are dropped by BetterAuth itself (fails closed to the shared bucket, never open) rather than rejected here.
const trustedProxyCidrs =
  process.env.TRUSTED_PROXY_CIDRS?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean) ?? [];

// Self-registration is on by default (self-hosters may want an open instance) and can be switched off with DISABLE_SIGNUP=true once the accounts exist. This gates email/password sign-up only — OIDC keeps provisioning users on first login, since who may authenticate is the IdP's decision.
export const signupDisabled = envFlag(process.env.DISABLE_SIGNUP);

// DISABLE_PASSWORD_LOGIN=true removes email/password sign-in entirely, leaving
// the IdP as the only way in — the setting an internet-facing instance wants, since a local password is a second door with no MFA behind it. Ignored (with a warning) when no OIDC provider is configured, so it can't lock everyone out of an instance that has no other way to sign in.
export const passwordLoginDisabled = !passwordLoginEnabled(
  process.env.DISABLE_PASSWORD_LOGIN,
  oidcEnabled,
);

if (
  envFlag(process.env.DISABLE_PASSWORD_LOGIN) &&
  !oidcEnabled &&
  process.env.NEXT_PHASE !== "phase-production-build"
) {
  logger.warn(
    "[auth] DISABLE_PASSWORD_LOGIN is set but no OIDC provider is configured — " +
      "ignoring it, since that would leave no way to sign in. Set OIDC_ISSUER/" +
      "OIDC_CLIENT_ID/OIDC_CLIENT_SECRET first.",
  );
}

// MCP server (issue #96): opt-in, because enabling it turns the instance into an OAuth authorization server whose client-registration endpoint (/api/auth/oauth2/register, RFC 7591) is unauthenticated by design — that is how an LLM client bootstraps itself, but it is a write surface an instance that doesn't want the feature shouldn't expose. Everything MCP is gated on this: the plugins, /api/mcp, the discovery documents and the MCP pages.
export const mcpEnabled = envFlag(process.env.ENABLE_MCP);

// Where the OAuth flow sends the browser for sign-in and for approval. Both are our pages rather than /sign-in directly — see src/app/mcp/.
export const MCP_AUTHORIZE_PATH = "/mcp/authorize";
export const MCP_CONSENT_PATH = "/mcp/consent";

// The MCP endpoint, and the OAuth resource identifier its tokens are bound to (their `aud`). Discovery, token issuance and verification must all agree on this string, so it is defined once.
export const MCP_ENDPOINT_PATH = "/api/mcp";
export const mcpResource = () => appUrl(MCP_ENDPOINT_PATH).toString();

// Public REST API (/api/v1, docs/architecture/api.md): opt-in like MCP. It adds no unauthenticated surface, but an API key is a long-lived bearer credential that bypasses SSO and its MFA — a second door an operator who relies on DISABLE_PASSWORD_LOGIN may not want. Gates the api-key plugin, the
// /api/v1 routes and Settings → API keys.
export const apiEnabled = envFlag(process.env.ENABLE_API);

// Bootstrap for user roles (issue #54): the account with this email becomes the first admin — at sign-up via the create hook below, or (for accounts that already exist) lazily on the next settings page load while the DB has no admin at all (ensureInitialAdmin in src/lib/admin.ts). Every later role change happens on Settings → Users.
export const initialAdminEmail =
  process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase() || null;

const discoveryUrl = oidcIssuer?.includes("/.well-known/")
  ? oidcIssuer
  : `${oidcIssuer?.replace(/\/+$/, "")}/.well-known/openid-configuration`;

// Validate the discovery endpoint once at boot so a wrong issuer shows up in the server log with an actionable message instead of only surfacing as INVALID_OAUTH_CONFIGURATION at sign-in time.
if (oidcEnabled && process.env.NEXT_PHASE !== "phase-production-build") {
  fetch(discoveryUrl)
    .then(async (res) => {
      const doc = res.ok ? await res.json().catch(() => null) : null;
      if (!res.ok || !doc?.authorization_endpoint) {
        logger.error(
          `[oidc] discovery failed at ${discoveryUrl} (status ${res.status}). ` +
            "Check OIDC_ISSUER — for Authentik it must be the application issuer, " +
            "e.g. https://<host>/application/o/<app-slug>/",
        );
      } else {
        logger.info(`[oidc] SSO enabled, issuer ${doc.issuer ?? discoveryUrl}`);
      }
    })
    .catch((err: unknown) => {
      logger.error({ err }, `[oidc] could not reach ${discoveryUrl}`);
    });
}

// Role computed from the OIDC groups claim for a user whose row doesn't exist yet: mapProfileToUser runs before the user is created, and BetterAuth strips additional fields marked `input: false` from provider profiles, so the role travels to the user-create hook out of band. Keyed by lowercased email; entries are consumed at creation and expire quickly so an aborted sign-up can't leak a role into a later, unrelated one.
const pendingOidcRoles = new Map<string, { role: UserRole; expires: number }>();

function takePendingOidcRole(email: string): UserRole | null {
  const entry = pendingOidcRoles.get(email);
  pendingOidcRoles.delete(email);
  if (!entry || entry.expires < Date.now()) return null;
  return entry.role;
}

// Syncs the user's role from the OIDC groups claim on every SSO login (the only moment we see the claim). Existing users are updated in place — mapProfileToUser can't do it through BetterAuth, see pendingOidcRoles — and first-time users get theirs at creation via the hook below. No-op unless a group mapping is configured and the claim is usable.
async function applyOidcGroupRole(profile: Record<string, unknown>) {
  const role = roleFromOidcGroups(profile.groups, {
    adminGroup: oidcAdminGroup,
    moderatorGroup: oidcModeratorGroup,
  });
  const email =
    typeof profile.email === "string" ? profile.email.toLowerCase() : null;
  if (!role || !email) return;
  pendingOidcRoles.set(email, { role, expires: Date.now() + 60_000 });
  await db
    .update(schema.user)
    .set({ role, updatedAt: new Date() })
    .where(
      and(
        sql`lower(${schema.user.email}) = ${email}`,
        ne(schema.user.role, role),
      ),
    );
}

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
      // Written by the jwt/mcp plugins only; harmless while MCP is off. Every model the plugins declare must be listed — BetterAuth checks this map against their schema at startup.
      jwks: schema.jwks,
      oauthClient: schema.oauthClient,
      oauthResource: schema.oauthResource,
      oauthClientResource: schema.oauthClientResource,
      oauthAccessToken: schema.oauthAccessToken,
      oauthRefreshToken: schema.oauthRefreshToken,
      oauthConsent: schema.oauthConsent,
      oauthClientAssertion: schema.oauthClientAssertion,
      // Written by the api-key plugin only; harmless while ENABLE_API is off.
      apikey: schema.apikey,
    },
  }),
  emailAndPassword: {
    // Off means BetterAuth stops serving /api/auth/sign-in/email entirely, so existing local credentials become unusable and SSO is the only way in. Sessions are unaffected — nobody signed in gets kicked out.
    enabled: !passwordLoginDisabled,
    // Enforced server-side by BetterAuth (a direct POST to
    // /api/auth/sign-up/email is rejected); the /sign-up page also hides.
    disableSignUp: signupDisabled,
  },
  user: {
    // Expose the role column (src/db/schema.ts) on session.user so the permission gates can read it; input: false keeps sign-up payloads from self-assigning a role.
    additionalFields: {
      role: {
        type: "string",
        required: false,
        defaultValue: "user",
        input: false,
      },
    },
  },
  databaseHooks: {
    user: {
      create: {
        // First-login role: the OIDC group mapping wins when it produced one (applyOidcGroupRole ran moments earlier in this request); otherwise the INITIAL_ADMIN_EMAIL account signs up as admin directly (covers fresh databases).
        before: async (user) => {
          const email = user.email.toLowerCase();
          return {
            data: {
              ...user,
              role:
                takePendingOidcRole(email) ??
                (initialAdminEmail && email === initialAdminEmail
                  ? "admin"
                  : "user"),
            },
          };
        },
      },
    },
  },
  account: {
    accountLinking: {
      enabled: true,
      // Let an SSO login attach to an existing email/password account with the same email instead of failing with account_not_linked.
      trustedProviders: ["oidc"],
      // Local accounts are never email-verified (we send no verification mails), so don't require that for linking. The IdP asserts the email.
      requireLocalEmailVerified: false,
    },
  },
  advanced: {
    ipAddress: {
      // Empty is the safe default: BetterAuth then only trusts a single-value X-Forwarded-For, falling back to the shared bucket described above rather than a spoofable multi-value chain.
      trustedProxies: trustedProxyCidrs,
    },
  },
  plugins: [
    ...(oidcEnabled
      ? [
          genericOAuth({
            config: [
              {
                providerId: "oidc",
                clientId: oidcClientId!,
                clientSecret: oidcClientSecret!,
                discoveryUrl,
                scopes: ["openid", "profile", "email"],
                // The pre-1.7 callback URL operators registered at their IdP — see OIDC_REDIRECT_PATH. Used for both the authorize request and the code exchange, so the two always agree.
                redirectURI: appUrl(OIDC_REDIRECT_PATH).toString(),
                // Users that don't exist yet are created on first SSO login (implicit sign-up is the default; spelled out here on purpose).
                disableImplicitSignUp: false,
                mapProfileToUser: async (profile) => {
                  // Runs on every OIDC callback — the hook that keeps roles in sync with IdP group membership.
                  await applyOidcGroupRole(profile);
                  const pick = (v: unknown) =>
                    typeof v === "string" && v.trim() ? v : null;
                  const email = pick(profile.email);
                  return {
                    name:
                      pick(profile.name) ??
                      pick(profile.preferred_username) ??
                      (email ? email.split("@")[0] : "User"),
                  };
                },
              },
            ],
          }),
        ]
      : []),
    // Mounts /api/auth/oauth2/* (authorize, consent, token, register, …).
    ...(mcpEnabled
      ? [
          // Signs the access tokens (JWTs, audience-bound to the MCP resource) and serves the JWKS /api/mcp verifies them against.
          jwt(),
          mcp({
            loginPage: MCP_AUTHORIZE_PATH,
            consentPage: MCP_CONSENT_PATH,
            // Without this the advertised resource would be the bare origin, and a client that checks the metadata against the server URL it was configured with (RFC 9728 §3.3) would refuse the token.
            resource: mcpResource(),
            // Claude, ChatGPT and Cursor register themselves (RFC 7591) before anyone has signed in; that is the only way they connect.
            allowDynamicClientRegistration: true,
            allowUnauthenticatedClientRegistration: true,
            // Custom-scheme redirect URIs (desktop apps) register as native.
            clientRegistrationDefaultApplicationType: "infer",
            // Access tokens are JWTs, checked by signature alone, so they can't be revoked early — disconnecting a client (Settings → MCP) only takes hold once the current one expires. Keep that window short; the refresh token carries the 30-day connection.
            accessTokenExpiresIn: 15 * 60,
          }),
        ]
      : []),
    // Mounts /api/auth/api-key/* for the signed-in user's own keys. Keys are created by our server action (src/app/settings/api-keys/actions.ts), because scopes ("permissions") are a server-only field: a key created straight through the HTTP endpoint carries none, which /api/v1 treats as no access at all.
    ...(apiEnabled
      ? [
          apiKey({
            defaultPrefix: API_KEY_PREFIX,
            requireName: true,
            maximumNameLength: 64,
            // Never: a key must not double as a browser session, or it would open every cookie-guarded page and server action, not just
            // /api/v1 with its scopes.
            enableSessionForAPIKeys: false,
            // The plugin's default is 10 requests per *day*. This is a per-key ceiling against a runaway script, not a quota.
            rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 600 },
            keyExpiration: { defaultExpiresIn: null, maxExpiresIn: 365 },
          }),
        ]
      : []),
  ],
});

export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}

// Where a page should send a signed-out visitor: /sign-in, carrying the page's own path (proxy-set header, validated) so login returns them here. For use in `if (!session) redirect(await signInRedirect())` guards.
export async function signInRedirect() {
  return signInPath((await headers()).get(CALLBACK_PATH_HEADER));
}
