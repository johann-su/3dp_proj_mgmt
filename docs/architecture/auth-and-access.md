# Auth & access control

*Read before touching auth, sessions, roles, or any page/route/action's access
checks. Update in the same PR that changes this behaviour.*

## The whole catalog is private

Instances hold paid models. Two layers: `src/proxy.ts` (Next 16's renamed
middleware) redirects pages without a session *cookie* to `/sign-in`, but
that's an optimistic presence check a hand-set cookie defeats and its matcher
skips `/api` — so every page also verifies the session server-side
(`getSession()` + redirect), and every API route and server action checks it
too (list-type actions return an empty page instead). Keep both checks when
adding a page. Both layers preserve the requested page across login (shared
links land where they pointed): the proxy redirects to
`/sign-in?callbackUrl=<path>` and also forwards the original path as the
`x-callback-path` request header, which the page-level guard reads — so write
the guard as `if (!session) redirect(await signInRedirect())` (from
`@/lib/auth`), not a bare `redirect("/sign-in")`. The callback value is
attacker-controlled (URL bar); `safeCallbackPath` (`src/lib/callback-url.ts`,
unit-tested) validates it down to an in-app path — reject-listing
absolute/protocol-relative URLs, control chars, and `/api`/auth paths — before
anything redirects to it, and the sign-in/sign-up pages re-validate server-side
before handing it to the client forms (email `router.push` and the OIDC
`callbackURL`).

There is no finer-grained RBAC on purpose: signed in = full read access, and
**editing is collaborative — any signed-in user can edit a model or
collection** (update fields/files, generate customizer variants, run
Onshape/MakerWorld sync, add/remove collection members), since a self-hosted
instance serves a trusted group and shared editing is worth more than the risk.
**Destructive/owner-scoped actions stay owner-gated**: deleting a model
(`deleteModel`, a soft delete into the owner's trash — see
[versioning](./versioning.md)) or collection (`deleteCollection`); deleting a
generated variant is owner-or-its-generator. When adding a mutation, follow
this split — open editing to any session, gate only deletion/ownership transfer
on `canActAsOwner(session.user, record.userId)` (owner, or a moderator/admin
acting owner-equivalent — see the roles section below).

## User roles

(issue #54; tier definitions + pure helpers in `src/lib/roles.ts`):
`user.role` is `user | moderator | admin`, exposed as `session.user.role` via
BetterAuth `user.additionalFields` (`input: false`, so sign-up payloads can't
self-assign a role). **Moderator = owner-equivalent on content**:
`canActAsOwner(session.user, ownerId)` is the standard owner gate and passes
for moderators/admins — model trash/restore/purge, collection deletion, variant
deletion, and the matching UI flags all use it; moderators also see (and their
page load sweeps) *everyone's* trash, and Settings → Duplicates
(`src/app/settings/duplicates/`, `isModerator` on the page *and* both actions)
is theirs to work through — see
[`import.md`](./import.md#duplicate-detection). **Admin = moderator + user
management**:
Settings → Users (`src/app/settings/users/`) lists all accounts, edits roles
(`setUserRole`) and deletes accounts (`deleteUser`) — the two mutations gated
on `isAdmin`; admins cannot change their own role or delete their own account,
so someone can always undo a mistake. Deleting a user purges their models up
front via `purgeModel` (the user-row FK cascade would leak the S3 objects) and
then lets the cascades take sessions, collections and credentials; their
version edits and generated variants on other users' models survive with the
reference nulled.

First-admin bootstrap: `INITIAL_ADMIN_EMAIL` applies only while the DB has
**no admin at all** — enforced at user creation
(`databaseHooks.user.create.before` in `src/lib/auth.ts`, covers fresh DBs
incl. first OIDC login) and lazily on settings-layout load
(`ensureInitialAdmin` in `src/lib/admin.ts`, covers accounts predating the
feature; same no-scheduler pattern as the trash sweep) — once an admin exists
it is inert, doubling as recovery for a zero-admin DB.

**OIDC group mapping**: `OIDC_ADMIN_GROUP` / `OIDC_MODERATOR_GROUP` name IdP
groups (exact strings from the `groups` claim; Authentik sends it with the
`profile` scope) whose membership is authoritative on every SSO login — synced
in `mapProfileToUser` (`applyOidcGroupRole`), which must update the row itself
because BetterAuth strips `input: false` fields from provider profiles; first
logins hand the role to the create hook via the `pendingOidcRoles` map. A
missing/malformed claim leaves stored roles untouched (no mass-demotion on IdP
misconfig). Deliberately **not** BetterAuth's organization plugin
(per-organization membership roles + org/member/invitation tables — the wrong
shape for one instance-global role) nor its admin plugin (would add
ban/impersonation endpoints and schema columns this app doesn't want). When
adding an owner-gated mutation use `canActAsOwner`; gate admin-only surfaces on
`isAdmin(session.user.role)`.

## Auth provider

Auth is BetterAuth email/password with sessions stored in Postgres.
`DISABLE_SIGNUP=true` turns off self-registration (BetterAuth's
`emailAndPassword.disableSignUp` plus hiding the `/sign-up` page); OIDC keeps
provisioning users on first login regardless — who may authenticate through SSO
is the IdP's decision.

`DISABLE_PASSWORD_LOGIN=true` goes further and sets
`emailAndPassword.enabled: false`, so BetterAuth stops serving the email
sign-in endpoint and the IdP becomes the only way in (existing sessions are
untouched; existing credential rows simply stop working). The sign-in page
hides the email/password fields and `/sign-up` redirects away, since
registering is email/password only. **The flag is ignored unless `oidcEnabled`**
— honouring it without an IdP would leave nobody able to sign in, and locking
the operator out is worse than the door it closes; the resolution lives in
`passwordLoginEnabled` (`src/lib/auth-config.ts`, unit-tested), kept in its own
module because `@/lib/auth` opens a DB pool at import time. Setting it without
OIDC logs a warning at boot.

**One surface authenticates without a session cookie**: the MCP server
(`/api/mcp`, issue #96) takes an OAuth bearer token instead, minted by
BetterAuth's `mcp` plugin, and a token carries the same whole-catalog read
access its user has. The whole thing — plugin, endpoint, discovery documents,
consent page — is off unless `ENABLE_MCP` is set, because enabling it also
opens an unauthenticated client-registration endpoint. See
[mcp.md](./mcp.md) before touching any of it.

Because signing in grants read access to the *whole* catalog, these two flags
plus `TRUSTED_PROXY_CIDRS` are the perimeter for any internet-facing instance —
see [self-hosting.mdx](../self-hosting.mdx#exposing-an-instance-to-the-internet).
Baseline security headers (CSP, HSTS, `frame-ancestors: none`, `nosniff`,
`Referrer-Policy`, `Permissions-Policy`) are set in `next.config.ts` rather than
at the proxy, so they hold however the app is fronted. The CSP keeps
`'unsafe-inline'` for scripts and styles: Next inlines its bootstrap/flight
payload, and tightening it means nonces, which means making every page dynamic.
