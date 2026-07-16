import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth } from "better-auth/plugins";
import { headers } from "next/headers";
import { and, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { roleFromOidcGroups, type UserRole } from "@/lib/roles";
import { CALLBACK_PATH_HEADER, signInPath } from "@/lib/callback-url";

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

// Optional IdP-group → role mapping (issue #54): the exact group names, as
// the IdP spells them in the OIDC `groups` claim (Authentik includes it with
// the standard `profile` scope). While configured, group membership is
// authoritative on every SSO login — joining the group grants the role,
// leaving it revokes it — so manage SSO users' roles in the IdP, not on
// Settings → Users. See roleFromOidcGroups in src/lib/roles.ts.
const oidcAdminGroup = process.env.OIDC_ADMIN_GROUP?.trim() || null;
const oidcModeratorGroup = process.env.OIDC_MODERATOR_GROUP?.trim() || null;

// Self-registration is on by default (self-hosters may want an open instance)
// and can be switched off with DISABLE_SIGNUP=true once the accounts exist.
// This gates email/password sign-up only — OIDC keeps provisioning users on
// first login, since who may authenticate is the IdP's decision.
export const signupDisabled = ["true", "1"].includes(
  process.env.DISABLE_SIGNUP?.trim().toLowerCase() ?? "",
);

// Bootstrap for user roles (issue #54): the account with this email becomes
// the first admin — at sign-up via the create hook below, or (for accounts
// that already exist) lazily on the next settings page load while the DB has
// no admin at all (ensureInitialAdmin in src/lib/admin.ts). Every later role
// change happens on Settings → Users.
export const initialAdminEmail =
  process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase() || null;

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

// Role computed from the OIDC groups claim for a user whose row doesn't
// exist yet: mapProfileToUser runs before the user is created, and BetterAuth
// strips additional fields marked `input: false` from provider profiles, so
// the role travels to the user-create hook out of band. Keyed by lowercased
// email; entries are consumed at creation and expire quickly so an aborted
// sign-up can't leak a role into a later, unrelated one.
const pendingOidcRoles = new Map<string, { role: UserRole; expires: number }>();

function takePendingOidcRole(email: string): UserRole | null {
  const entry = pendingOidcRoles.get(email);
  pendingOidcRoles.delete(email);
  if (!entry || entry.expires < Date.now()) return null;
  return entry.role;
}

// Syncs the user's role from the OIDC groups claim on every SSO login (the
// only moment we see the claim). Existing users are updated in place —
// mapProfileToUser can't do it through BetterAuth, see pendingOidcRoles —
// and first-time users get theirs at creation via the hook below. No-op
// unless a group mapping is configured and the claim is usable.
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
    },
  }),
  emailAndPassword: {
    enabled: true,
    // Enforced server-side by BetterAuth (a direct POST to
    // /api/auth/sign-up/email is rejected); the /sign-up page also hides.
    disableSignUp: signupDisabled,
  },
  user: {
    // Expose the role column (src/db/schema.ts) on session.user so the
    // permission gates can read it; input: false keeps sign-up payloads from
    // self-assigning a role.
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
        // First-login role: the OIDC group mapping wins when it produced
        // one (applyOidcGroupRole ran moments earlier in this request);
        // otherwise the INITIAL_ADMIN_EMAIL account signs up as admin
        // directly (covers fresh databases).
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
              mapProfileToUser: async (profile) => {
                // Runs on every OIDC callback — the hook that keeps roles in
                // sync with IdP group membership.
                await applyOidcGroupRole(profile);
                return {
                  name:
                    profile.name ||
                    profile.preferred_username ||
                    (typeof profile.email === "string"
                      ? profile.email.split("@")[0]
                      : "User"),
                };
              },
            },
          ],
        }),
      ]
    : [],
});

export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}

// Where a page should send a signed-out visitor: /sign-in, carrying the
// page's own path (proxy-set header, validated) so login returns them here.
// For use in `if (!session) redirect(await signInRedirect())` guards.
export async function signInRedirect() {
  return signInPath((await headers()).get(CALLBACK_PATH_HEADER));
}
