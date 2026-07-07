# 3D printing project management

This project should be a self hostable project management platform for .3mf files (stl/step upload was removed to keep the UI and ingestion simple — 3mf is a container with embedded metadata and images). Its structure should mirror [Makerworld](https://makerworld.com) or [Printables](https://printables) - just being completely self hostable.

## Features

- **Model management** — upload one or more `.3mf` files per model; title, description, images, and printer tags auto-fill from embedded file metadata
- **Catalog** — searchable homepage grid with collections; dedicated model detail page with per-file downloads
- **Collections** — user-organized groups of models with an "Add to collection" action on model pages
- **Bill of Materials** — per-model item list (name, quantity, optional link/image); CSV upload in the creation wizard and download via the model page
- **PDF documents** — attach build instructions or manuals; viewed inline in the browser and downloadable
- **Markdown descriptions** — GitHub-flavored markdown; raw HTML is never rendered
- **Platform import** — import metadata and images from MakerWorld and Printables; MakerWorld `.3mf` file downloads require a connected Bambu Cloud account (Settings → Bambu Cloud)
- **Onshape integration** — import models via document URL (OAuth2 "Sign in with Onshape"); sync when the document changes or pin an immutable version snapshot; "Edit in Onshape" button on imported models
- **Print estimates** — optional slicer service (headless PrusaSlicer) estimates print time and filament use from uploaded `.3mf` files using the settings embedded in the file; shows printer hardware info per file
- **Open in slicer** — open files directly in OrcaSlicer or Bambu Studio as an alternative to downloading
- **Authentication** — email/password with optional OIDC SSO; all pages require sign-in

**Planned:**
- 3D preview of objects in the browser
- Parametric models via [OpenSCAD](https://openscad.org/)
- Bambu printer integration — send print jobs and monitor prints

## Tech stack

- Nextjs
- shadcn
- BetterAuth
- s3 block storage backend
- postgres db (through drizzle orm)

## Development

Requirements: Node 22+, Docker, and an S3-compatible storage (AWS S3, MinIO, Garage, …) with a bucket whose credentials have read/write access.

```sh
cp .env.example .env       # then fill in BETTER_AUTH_SECRET and your S3 settings
docker compose up -d       # starts Postgres on :5432 and the slicer service on :8000
npm install
npm run db:migrate         # apply SQL migrations from ./drizzle + seed categories
npm run dev
```

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
