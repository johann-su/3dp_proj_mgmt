# 3D printing project management

This project should be a self hostable project management platform for .3mf files. Its structure should mirror [Makerworld](https://makerworld.com) or [Printables](https://printables) - just being completely self hostable.

## Features

- **Model management** — upload one or more `.3mf` files per model; title, description, images, and printer tags auto-fill from embedded file metadata
- **Catalog** — browsable homepage grid with collections; dedicated model detail page with per-file downloads
- **Search** — dedicated `/search` page with fuzzy (typo-tolerant) matching across models and collections, filters (type, uploader, printer, filament, nozzle diameter, print time) and sort (relevance, newest, oldest)
- **Collections** — user-organized groups of models with an "Add to collection" action on model pages
- **Bill of Materials** — per-model item list (name, quantity, optional link/image); CSV upload in the creation wizard and download via the model page
- **PDF documents** — attach build instructions or manuals; viewed inline in the browser and downloadable
- **Markdown descriptions** — GitHub-flavored markdown; raw HTML is never rendered
- **Platform import** — import metadata and images from MakerWorld and Printables; MakerWorld `.3mf` file downloads require a connected Bambu Cloud account (Settings → Bambu Cloud)
- **Collection import** — paste a MakerWorld collection URL to import every model in it in the background into a new collection; progress ring in the header with cancel (requires a connected Bambu account); imported collections link back to their source and can sync new remote models later
- **Onshape integration** — import models via document URL (OAuth2 "Sign in with Onshape"); sync when the document changes or pin an immutable version snapshot; "Edit in Onshape" button on imported models
- **Print estimates** — optional slicer service (headless PrusaSlicer) estimates print time and filament use from uploaded `.3mf` files using the settings embedded in the file; shows printer hardware info per file
- **Parametric OpenSCAD models** — upload or import a `.scad` source (Printables and MakerWorld parametric models) and generate customized `.3mf` files from its customizer parameters via the optional headless OpenSCAD service; generated variants get print estimates and slicer deep links like any upload
- **Open in slicer** — open files directly in OrcaSlicer or Bambu Studio as an alternative to downloading
- **Pagination** — cursor-based endless scroll on the list screens (homepage `/` models grid, `/collections`)
- **Authentication** — email/password with optional OIDC SSO; all pages require sign-in
- **User roles** — moderators/admins act owner-equivalent on all models and collections (delete, restore, purge — e.g. to clean up abandoned content); admins additionally manage everyone's role under Settings → Users, with the first admin designated via `INITIAL_ADMIN_EMAIL`

## Tech stack

- Nextjs
- shadcn
- BetterAuth
- s3 block storage backend
- postgres db (through drizzle orm)

## Development

Requirements: Node 22+, Docker, and an S3-compatible storage (AWS S3, MinIO, Garage, …) with a bucket whose credentials have read/write access.

### First-time setup

```sh
cp .env.example .env       # then fill in BETTER_AUTH_SECRET and your S3 settings
docker compose up -d       # starts Postgres on :5432, the slicer service on :8000 and the openscad service on :8001
npm install
npm run db:migrate         # apply SQL migrations from ./drizzle + seed categories
```

### Day to day

`compose.yml`'s `postgres`, `slicer` and `openscad` services are the only things
Docker runs in dev — `npm run dev` runs Next.js directly on the host (not in a
container) and just connects to them over `localhost`. They aren't started for
you, so bring them up first each time you come back to the project:

```sh
docker compose up -d       # no-op if postgres/slicer/openscad are already running
npm run dev
```

If `npm run dev` immediately throws `ECONNREFUSED` from a Drizzle query (e.g.
`select … from "categories"`) or Better Auth's session lookup, Postgres isn't up —
run `docker compose up -d` (or `docker compose ps` to check what's running) and
restart the dev server. `docker compose down` stops both containers again.

Note for [Garage](https://garagehq.deuxfleurs.fr/) users: `S3_REGION` must match the
`s3_api.s3_region` value of your Garage config (default `garage`), and the access key
needs `garage bucket allow --read --write <bucket> --key <key>`.

Schema changes: edit `src/db/schema.ts`, then `npm run db:generate` to create a new
migration (or `npm run db:push` to sync directly during development).

## Self-hosting

The `app` service in `compose.yml` builds a production image (Next.js standalone
output) that applies migrations and seeds categories on boot:

```sh
export BETTER_AUTH_SECRET=$(openssl rand -base64 32)
export BETTER_AUTH_URL=https://your-domain.example
export S3_ENDPOINT=https://your-s3-endpoint
export S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… S3_BUCKET=models
docker compose --profile app up -d --build
```

### OIDC single sign-on (optional)

Set `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` to show an SSO button
below the email/password form on the sign-in page (`OIDC_PROVIDER_NAME` customizes
the button label). The issuer must serve `/.well-known/openid-configuration`
(a full discovery URL is also accepted), and the client must be registered with the
redirect URI `{BETTER_AUTH_URL}/api/auth/oauth2/callback/oidc`. Users are created on
first SSO login, and an SSO login with the same email links to an existing
email/password account.

**Authentik:** the issuer is per application, not the domain root — use
`https://<host>/application/o/<app-slug>/` (shown as "OpenID Configuration Issuer"
in the provider settings). A wrong issuer is logged at server start with the exact
discovery URL that failed.

### User roles

Every account starts as a plain **user**: full read access and collaborative
editing, with destructive actions (deleting a model or collection) limited to
what they own. Two elevated roles exist for cleanup and administration:

- **Moderator** — owner-equivalent on all content: may delete, restore, or
  permanently purge any model, delete any collection, remove any generated
  variant, and sees every user's trash under `/models/trash`.
- **Admin** — everything a moderator can do, plus user management: the
  **Settings → Users** page lists all accounts and changes their roles.

Bootstrap the first admin by setting `INITIAL_ADMIN_EMAIL` to an account's
email: while the database has no admin at all, that account is promoted at
sign-up or on its next visit to any settings page. Once an admin exists the
variable does nothing (roles are managed in the UI), but it also recovers an
instance whose last admin account is gone. With OIDC, the IdP still decides
who may *sign in* — roles only govern permissions inside the app.

**Roles from IdP groups (optional):** set `OIDC_ADMIN_GROUP` (and/or
`OIDC_MODERATOR_GROUP`) to the exact group names your IdP sends in the OIDC
`groups` claim — e.g. `OIDC_ADMIN_GROUP=homelab-admins` with an Authentik
group of that name (Authentik includes the claim with the standard `profile`
scope). While configured, group membership is authoritative on every SSO
login: members of the group get the role, and a user in neither mapped group
is (re)set to a plain user — so manage SSO users' roles in the IdP rather
than on Settings → Users. If the IdP stops sending the `groups` claim
entirely, stored roles are left untouched.
