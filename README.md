# 3D printing project management

This project should be a self hostable project management platform for .3mf files (stl/step upload was removed to keep the UI and ingestion simple — 3mf is a container with embedded metadata and images). Its structure should mirror [Makerworld](https://makerworld.com) or [Printables](https://printables) - just being completely self hostable.

## Features

MVP:
- [x] Creating a model (ie one or multiple .3mf files that together make up one coherent model)
- [x] Upload .3mf file
- [x] Add metadata (title, description, images, category, tags)
- [x] A homepage where the models are listed and searchable
- [x] A details page for every model when clicking on it where the project files can be downloaded (like makerworlds print profiles tab)

After MVP works:
- [x] Prefill title, description, images and a printer tag (e.g. "bambu p1s") from uploaded .3mf files
- [x] Collections: folders/groups of models (per user, "Add to collection" on model pages)
- [x] Import from other platforms (makerworld & printables only) — metadata and
  images always import; MakerWorld `.3mf` downloads work once the user connects a
  Bambu Cloud account under Settings → Bambu Cloud (see Architecture notes)
- [x] Bill of Materials (BOM) for models
  - filament, heat set inserts etc
  - Item (name), quantitiy, link (optional), image (optional)
  - downloadable as csv (`GET /api/models/{id}/bom`)
  - displayed on the model page above the description, below the images
  - upload csv in model creation wizard (columns: name, quantity, link, image —
    header aliases like qty/url/picture work too) or add rows manually
- [x] Open in OrcaSlicer / BambuStudio option which opens the app on the users pc and opens the .3mf file in it (as an alternative to "download .3mf")
- [x] Have optional PDF's associated with a model for build instructions, product manual etc
  - added in the wizard's details step ("Documents"), shown on the model page
    below the files card — opens inline in the browser, downloadable
- [x] Markdown support for Description
  - GitHub-flavored markdown (react-markdown + remark-gfm); raw HTML is never
    rendered
- [ ] Show collections on homescreen
- [x] Onshape integration (via "Sign in with Onshape" OAuth, see Architecture notes)
  - import models from onshape (paste onshape document url -> backend exports
    the tabs as `.step` and downloads them)
  - sync with onshape ("Sync from Onshape" on the model page re-exports when
    the document changed; a `…/v/…` version link pins an immutable snapshot)
  - edit in onshape button for models imported from onshape -> opens this model in onshape editor
- [ ] third slicing backend container running libslicr3d / prusa slicer headless
  - if an unsliced .3mf file is uploaded, slice it to estimate print time & material use
  - flag failure to slice correctly (ie let user know they (mistakenly) uploaded an unslicable file)

Substantial effort features in the future:
- [ ] parametric models with [OpenSCAD](https://openscad.org/) - lower priority if onshape integration works
- [ ] integration with (bambu) 3d printer - slicer integration makes this sort off redundant
  - send jobs to the printer
  - monitor print jobs

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
docker compose up -d       # starts Postgres on :5432
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

## Architecture notes

- **Uploads** stream through `POST /api/upload` to S3 (no browser↔S3 CORS setup needed);
  only signed-in users can upload, and file extensions are validated server-side.
- **Downloads & images** stream from S3 through `GET /api/files/[id]`, so the S3
  endpoint never needs to be reachable from the browser.
- **Auth** is BetterAuth email/password with sessions stored in Postgres.
- **.3mf import** (`src/lib/threemf.ts`) runs client-side on file selection: the zip is
  unpacked in the browser (fflate) and title/description (`3D/3dmodel.model`), printer
  name (`Metadata/project_settings.config` / `slice_info.config`) and preview images
  (`Auxiliaries/`, `Metadata/plate_*.png`, thumbnails) prefill the form.
- **URL import** (`POST /api/import`, `src/lib/import/`) fetches a model's public
  metadata + images server-side and stages them to S3 for the create form.
  MakerWorld uses the anonymous `api.bambulab.com/v1/design-service/design/{id}`
  JSON API (the makerworld.com pages themselves are Cloudflare-gated); Printables
  uses its public GraphQL API, which also yields anonymous file download links.
  MakerWorld file downloads require a Bambu Cloud login: a user connects their
  account at **Settings → Bambu Cloud** (`src/app/settings/bambu/`, backed by
  `src/lib/bambu/`), which logs in via `api.bambulab.com` (handling email-code
  and TOTP two-factor) or accepts a pasted `token` cookie. The resulting access
  token is stored **encrypted at rest** (AES-256-GCM, `src/lib/crypto.ts`, keyed
  by `BAMBU_TOKEN_SECRET`/`BETTER_AUTH_SECRET`). At import time the token
  exchanges each print profile for a short-lived presigned URL that streams to
  S3 like any other asset. Without a connection, only metadata + images import.
- **Onshape integration** (`src/lib/onshape/`, `src/lib/import/onshape.ts`)
  authenticates with OAuth2 ("Sign in with Onshape", the flow behind
  [passport-onshape](https://github.com/onshape/passport-onshape), implemented
  directly in `src/lib/onshape/oauth.ts`): the self-hoster registers one OAuth
  app at dev-portal.onshape.com (redirect URL
  `{BETTER_AUTH_URL}/api/onshape/callback`, read documents + profile scopes)
  and sets `ONSHAPE_CLIENT_ID`/`ONSHAPE_CLIENT_SECRET`; users then connect
  under **Settings → Onshape** via consent screen — no API keys to copy.
  Access + refresh tokens are stored encrypted at rest like the Bambu token,
  access tokens are refreshed transparently (~60 min lifetime, rotated refresh
  tokens), and a connection that can no longer be refreshed is dropped so the
  user simply reconnects. Importing a
  `cad.onshape.com/documents/…` URL reads the document metadata + thumbnail and
  runs an asynchronous STEP export of the linked tab (or of every Part
  Studio/Assembly tab), polling `GET /translations/{tid}` until done; the
  resulting `.step` files stream to S3 like any other asset (`.step` is the one
  exception to the 3mf-only upload rule). The canonical document URL is stored
  as the model's `sourceUrl` (doubling as the "Edit in Onshape" link) together
  with the workspace microversion; "Sync from Onshape" (owner-only,
  `POST /api/models/{id}/onshape-sync`) compares the current microversion and
  re-exports, replacing the previously imported files (tracked via
  `model_files.onshape_element_id`). Workspace (`…/w/…`) links follow the
  branch; version (`…/v/…`) links pin an immutable snapshot and never sync.
- **Search** is Postgres `ILIKE` over title/description plus category filtering.
