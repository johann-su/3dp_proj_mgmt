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
  Bambu Cloud account under Settings → Bambu Cloud (see the architecture notes
  in `AGENTS.md`)
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
- [x] Show collections on homescreen
- [x] Onshape integration (via "Sign in with Onshape" OAuth, see the
  architecture notes in `AGENTS.md`)
  - import models from onshape (paste onshape document url -> backend exports
    the tabs as `.3mf` and downloads them)
  - sync with onshape ("Sync from Onshape" on the model page re-exports when
    the document changed; a `…/v/…` version link pins an immutable snapshot)
  - edit in onshape button for models imported from onshape -> opens this model in onshape editor
- [x] third slicing backend container (in addition to nextjs and postgres) running libslicr3d / prusa slicer headless
  - if an unsliced .3mf file is uploaded, slice it to estimate print time & material use
  - flag failure to slice correctly (ie let user know they (mistakenly) uploaded an unslicable file)
  - implemented as the `slicer` service in `compose.yml` wrapping the
    PrusaSlicer CLI (libslic3r has no maintained standalone bindings, so the
    container uses the `prusa-slicer` binary headless — see the architecture
    notes in `AGENTS.md`)
  - slices with the settings embedded in the file (printer kinematics, speeds,
    layer height, infill, the filament the objects actually use, …); a generic
    0.4 mm/PLA profile is only the fallback for files without settings
  - the selected hardware (printer model, nozzle, build plate, filament) is
    stored on the file (`model_files.printer_info`) and shown on the model page
- [x] Replace header with shadcn sidebar component
- [x] Add dedicated user settings page for onshape and bambu connection
- [x] Download .3mf from onshape (instead of step)
  - check with slicer backend (fallback to default pla profile is fine)
- [x] Confirm dialog for destructive actions (delete model, delete collection)
- [x] Fix Collection ui (stacked cards arent evenly spaced - see ~/Desktop/screenshot-1.png)
- [x] Create unit tests, add guidance to agents.md
- [x] Unauthenticated -> redirect to login (every page including homepage should be authenticated)
- [x] Make the BOM on the models page collapsible
- [x] Fix checkmarks in the add to collection menu in model details page
- [ ] How are onshape branches/versions handled? Maybe add this as a setting?

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
