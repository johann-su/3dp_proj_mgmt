# 3D printing project management

This project should be a self hostable project management platform for .3mf / .step / .stl files. Its structure should mirror [Makerworld](https://makerworld.com) or [Printables](https://printables) - just being completely self hostable.

## Features

MVP:
- [x] Creating a model (ie one or multiple .3mf / .step / .stl files that together make up one coherent model)
- [x] Upload .3mf / .step / .stl file
- [x] Add metadata (title, description, images, category, tags)
- [x] A homepage where the models are listed and searchable
- [x] A details page for every model when clicking on it where the project files can be downloaded (like makerworlds print profiles tab)

After MVP works:
- [x] Prefill title, description, images and a printer tag (e.g. "bambu p1s") from uploaded .3mf files
- [x] Collections: folders/groups of models (per user, "Add to collection" on model pages)
- [x] Import from other platforms (makerworld & printables only) — Create → "Import from URL".
  Printables: metadata, images and model files are fetched server-side and prefilled.
  MakerWorld: metadata + images when reachable; file downloads require a Bambu account and
  Cloudflare usually blocks server-side fetches — fallback is uploading the .3mf manually
  (its metadata is extracted automatically). Imported models link back via `source_url`.

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

The `app` service in `docker-compose.yml` builds a production image (Next.js standalone
output) that applies migrations and seeds categories on boot:

```sh
export BETTER_AUTH_SECRET=$(openssl rand -base64 32)
export BETTER_AUTH_URL=https://your-domain.example
export S3_ENDPOINT=https://your-s3-endpoint
export S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… S3_BUCKET=models
docker compose --profile app up -d --build
```

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
- **Search** is Postgres `ILIKE` over title/description plus category filtering.
