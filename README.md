# 3D printing project management

Self-hostable project management platform for `.3mf` files. Its structure
mirrors [MakerWorld](https://makerworld.com) or
[Printables](https://www.printables.com) — just completely self hostable:
models, print profiles, images and documents live in your own Postgres
database and S3-compatible storage.

Model management with metadata auto-fill from `.3mf` files, fuzzy search,
collections, bills of materials and PDF manuals; imports from MakerWorld,
Printables and Onshape (with later re-sync); print time estimates via a
headless slicer; parametric OpenSCAD customization; "open in slicer" deep
links; email/password sign-in with optional OIDC SSO and user roles.

## Documentation

Operator/user documentation — install & self-hosting, the full configuration
reference, OIDC SSO, user roles, feature overview and integration setup
(Onshape, Bambu Cloud, MakerWorld/Printables) — is authored in
[`docs/`](docs) and published as a standalone docs site built from
[`nextra/`](nextra). The site is deployed separately from the app on its own
subdomain (see `nextra/Dockerfile`); no instance builds or serves it.

Quick start for a self-hosted deployment (details in
[`docs/self-hosting.mdx`](docs/self-hosting.mdx)):

```sh
export BETTER_AUTH_SECRET=$(openssl rand -base64 32)
export BETTER_AUTH_URL=https://your-domain.example
export S3_ENDPOINT=https://your-s3-endpoint
export S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… S3_BUCKET=models
docker compose --profile app up -d --build
```

## Tech stack

- Nextjs
- shadcn
- BetterAuth
- s3 block storage backend
- postgres db (through drizzle orm)

## Development

Requirements: Node 22+, Docker, and an S3-compatible storage (AWS S3, MinIO,
Garage, …) with a bucket whose credentials have read/write access.

### First-time setup

```sh
cp .env.example .env       # then fill in BETTER_AUTH_SECRET and your S3 settings
docker compose up -d       # starts Postgres on :5432, the slicer service on :8000 and the openscad service on :8001
npm install
npm run db:migrate         # apply SQL migrations from ./drizzle + seed categories
```

### Day to day

`compose.yml`'s `postgres`, `slicer` and `openscad` services are the only things Docker runs in dev — `npm run dev` runs Next.js directly on the host (not in a container) and just connects to them over `localhost`. They aren't started for you, so bring them up first each time you come back to the project:

```sh
docker compose up -d       # no-op if postgres/slicer/openscad are already running
npm run dev
```

If `npm run dev` immediately throws `ECONNREFUSED` from a Drizzle query (e.g. `select … from "categories"`) or Better Auth's session lookup, Postgres isn't up — run `docker compose up -d` (or `docker compose ps` to check what's running) and restart the dev server. `docker compose down` stops both containers again.

Note for [Garage](https://garagehq.deuxfleurs.fr/) users: `S3_REGION` must match the `s3_api.s3_region` value of your Garage config (default `garage`), and the access key needs `garage bucket allow --read --write <bucket> --key <key>`.

Schema changes: edit `src/db/schema.ts`, then `npm run db:generate` to create a new migration (or `npm run db:push` to sync directly during development).

### Docs site

The docs site is its own npm package (deliberately not a workspace member, so
its Next version never clashes with the app's):

```sh
cd nextra && npm install && npm run dev   # serves docs/ on :3002
```

Content lives in `docs/` (reached through the `nextra/content` symlink);
`docs/architecture/` holds dev-facing notes and is excluded from the site.
Build the deployable image from the repo root with
`docker build -f nextra/Dockerfile -t print-vault-docs .`.
