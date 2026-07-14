---
name: verify
description: How to run and drive this app locally to verify changes end-to-end (dev server quirks, test sessions, invoking server actions over HTTP, DB access).
---

# Verifying changes against the running app

## Environment

The compose services (postgres on `localhost:5432`, slicer `:8000`, openscad
`:8001`) are normally already running — check `docker ps`. S3 is the real
remote endpoint from `.env`; avoid creating files (a model row without files
never touches S3). Apply migrations with `npm run db:migrate`.

## Dev server

`npm run dev` **daemonizes** (Next 16) and the daemon does *not* inherit
shell env vars reliably — put temporary env vars in `.env` (back it up,
restore after) and restart. Stop with `pkill -f "next dev"`. Wait for
`curl -s http://localhost:3000/sign-in` → 200.

## Sessions

Self-signup is open in dev. Create/log in test users straight over HTTP and
keep cookie jars per user:

```sh
curl -c admin.jar -X POST localhost:3000/api/auth/sign-up/email \
  -H 'Content-Type: application/json' \
  -d '{"email":"verify-admin@test.local","password":"pw-123456","name":"Verify Admin"}'
# later logins: /api/auth/sign-in/email with email+password
```

Use throwaway `verify-*@test.local` emails and delete them afterwards.

## Invoking server actions over HTTP

Server actions are POSTs to the page path with a `Next-Action` header. The
action id differs between `npm run build` output and the live Turbopack dev
compile — **don't** trust `.next/server/server-reference-manifest.json` while
dev is running ("Server action not found"). Get the live id from the served
client chunks:

1. Fetch the page HTML with a session jar, extract `src="/_next/…*.js"`.
2. Download those chunks and grep for
   `__next_internal_action_entry_do_not_use__ [{"<40-hex-id>":{"name":"<action>"}`.
3. Call it:

```sh
curl -b admin.jar -X POST localhost:3000/settings/users \
  -H "Next-Action: <id>" -H 'Content-Type: text/plain;charset=utf-8' \
  -d '[{"userId":"…","role":"moderator"}]'
```

The response is an RSC payload; action return values appear as
`1:{"error":"…"}`-style lines, redirects as a 303.

## Database

```sh
docker exec stl_proj_mgmt-postgres-1 psql -U stl -d stl -c "…"
```

Insert test rows directly (e.g. a model: `INSERT INTO models (title, user_id)
VALUES (…)`) and clean up everything you created at the end.

## Not drivable locally

OIDC login (needs the real Authentik IdP + browser consent) and Bambu/Onshape
connections. Verify around them and say so.
