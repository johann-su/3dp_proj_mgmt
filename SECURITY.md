# Security policy

## Threat model

This is a self-hosted application: every instance is somebody's own deployment,
holding their own (often paid-for) models, print profiles, manuals and BOMs. Two
assumptions drive every security decision in the codebase, and they should drive
your bug reports and your patches too.

**1. The expected deployment is a private network, serving a trusted group.**
Signing in grants read access to the *whole* catalog, and any signed-in user may
edit any model or collection — there is no per-model ACL and no finer-grained
RBAC, on purpose (see
[`docs/architecture/auth-and-access.md`](docs/architecture/auth-and-access.md)).
Only destructive/owner-scoped actions (deleting a model or collection, managing
users) are gated, and moderators/admins pass those gates. Likewise, uploads and
OpenSCAD renders are not size- or quota-capped, and imports make the server
fetch URLs that MakerWorld/Printables hand back. All of that is a deliberate
trade for a trusted group — it is documented behaviour, not a vulnerability.

**2. Any instance may nevertheless end up exposed to the internet — so nothing
private may leak to an unauthenticated visitor.** This is the line that matters.
Authentication is the entire perimeter, so **an unauthenticated read of any
model, file, image, document or metadata is a security bug**, and the highest
severity this project recognises. Concretely, the invariants we defend:

- **Every page, API route and server action verifies the session server-side.**
  `src/proxy.ts` (Next 16's renamed middleware) is an *optimistic cookie check
  only* — a hand-set cookie defeats it and its matcher skips `/api`. It is a UX
  redirect, never the access control.
- **Files are never served from S3 directly.** All downloads and images stream
  through `GET /api/files/[id]`, which requires a session cookie *or* a signed
  file token (HMAC over file id + expiry, keyed off `BETTER_AUTH_SECRET` — see
  [`docs/architecture/files.md`](docs/architecture/files.md)). The S3 bucket
  itself is expected to be private and unreachable from the browser; a public
  bucket, or a route that returns a presigned S3 URL to a client, defeats the
  whole model.
- **File tokens are bearer capabilities, and that is by design.** Anyone holding
  a `?token=…` URL can read *that one file* until it expires. They exist because
  the Next image optimizer and slicer deep links cannot send cookies. A token
  that grants more than its one file, that never expires, or that can be forged
  or extended without the secret, is a bug.
- **Stored content types are derived from an allowlisted extension**, never from
  a client-supplied header — `/api/files` serves images inline on our own
  origin, so an uploader-chosen `text/html` would be stored XSS.
- **Redirect targets, archive entry names and outbound fetch targets are
  validated**: `safeCallbackPath` for post-login redirects, zip-slip-safe entry
  names in model exports, and the SSRF guard in `src/lib/net-guard.ts` for the
  BOM image proxy (private, loopback, link-local and cloud-metadata ranges are
  blocked). Weakening any of these is in scope.
- **Baseline security headers ship with the app** (CSP, HSTS, `frame-ancestors`,
  `nosniff`, `Referrer-Policy`, `Permissions-Policy`) in `next.config.ts`, so
  they hold however the instance is fronted.
- **Secrets at rest are encrypted** (AES-256-GCM, `src/lib/crypto.ts`) for the
  credentials the app must store and reuse — Bambu Cloud and Onshape tokens.
- **The MCP server is off by default** (`ENABLE_MCP`): enabling it turns the
  instance into an OAuth authorization server with an intentionally
  unauthenticated client-registration endpoint. Anything that makes MCP surfaces
  reachable without `ENABLE_MCP=true`, or that lets an approved MCP client read
  beyond the catalog, is a bug.

## Reporting a vulnerability

**Please report privately — do not open a public issue.**

- Preferred: GitHub → the repository's **Security** tab → **Report a
  vulnerability** (private security advisory).
- Or email **johann@jhns.me**.

Useful in a report: affected version or commit, the configuration it needs (env
vars, whether sign-up is open, whether MCP/OIDC/slicer are enabled), reproduction
steps or a proof of concept, and what an attacker gets out of it.

This is a small, unfunded, single-maintainer project. Expect an acknowledgement
within about a week and a fix timeline in the first reply. There is no bug
bounty. Please give a reasonable window (90 days is a good default, less for
something already being exploited) before disclosing publicly; credit in the
advisory and release notes is yours unless you'd rather stay anonymous.

## Supported versions

Pre-1.0 and moving fast: **only the latest release and the `main` branch are
supported**. Fixes land there and are not back-ported. Self-hosters should track
releases and update; the Docker image and `compose.yml` make that a rebuild.

## In scope

The application in this repository — the Next.js app, the slicer service
(`slicer/`), the OpenSCAD service (`openscad/`), the Dockerfile and
`compose.yml` — and its documented default configuration.

## Out of scope

- Anything requiring a valid session that only reaches data or actions a
  signed-in user is *meant* to have, per assumption 1 above: reading or editing
  another user's model, exporting a model, missing upload quotas or size caps.
  If you think one of those crosses into genuine harm, report it anyway and say
  why — the boundary is a judgement call.
- Misconfiguration of an operator's own deployment: a public S3 bucket, a weak
  or shared `BETTER_AUTH_SECRET`, an instance left on the internet with sign-up
  open, a reverse proxy that forwards a forged `X-Forwarded-For`, or the
  `.env` file's contents. See the hardening checklist below.
- Findings against third-party services this app talks to (Onshape, Bambu Cloud,
  MakerWorld, Printables, your IdP) — report those to them.
- Vulnerabilities in dependencies with no exploitable path through this app;
  Renovate keeps them current. A scanner's raw output is not a report.
- Denial of service through resource exhaustion by an authenticated user, and
  self-XSS or attacks requiring the victim to paste code into a console.

## Hardening checklist for operators

Full detail in [`docs/self-hosting.mdx`](docs/self-hosting.mdx); the short
version for an instance reachable from the internet:

- **`DISABLE_SIGNUP=true`** once your accounts exist. The one that matters most:
  open registration means an open catalog.
- **`DISABLE_PASSWORD_LOGIN=true` alongside [OIDC SSO](docs/sso.mdx)**, so every
  login inherits your IdP's MFA, password policy and lockout rules. Without it,
  local passwords are a second way in behind only a per-IP rate limit.
- **A strong, unique `BETTER_AUTH_SECRET`** (`openssl rand -base64 32`). It also
  keys the signed file tokens and, by default, the encrypted Bambu/Onshape
  credentials.
- **Keep the S3 bucket and Postgres private.** Neither needs to be reachable
  from the browser — all file traffic proxies through the app.
- **Terminate TLS at your reverse proxy**; the app listens on `127.0.0.1:3000`
  and ships HSTS itself.
- **Set `TRUSTED_PROXY_CIDRS` only if your proxy chain actually needs it** —
  setting it when you don't breaks sign-in rate limiting instead of fixing it.
  The doc explains how to check.
- **Leave `ENABLE_MCP` unset** unless you want the OAuth authorization server and
  its open client-registration endpoint.

## For contributors

Before changing auth, file serving, imports or the MCP server, read the matching
file in [`docs/architecture/`](docs/architecture/README.md) — the invariants
above live there with their reasoning, and each doc says what to update when you
change its behaviour. New pages, routes and server actions must carry their own
session check; new model listings must filter `deleted_at IS NULL`. Report any
security-relevant behaviour change in the PR description.
