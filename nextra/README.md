# Operator docs site

Standalone [Nextra](https://nextra.site) app that publishes the operator/user
documentation (issue #72). It is deliberately **its own npm package** — not a
root workspace member — so its Next.js version never shares a `node_modules`
with the app's, and it is **not** part of `compose.yml`: the site describes
the software, not one deployment, and is deployed once by the project on its
own subdomain.

- **Content** is the top-level [`docs/`](../docs) directory, reached through
  the `content -> ../docs` symlink (Nextra offers no config option for the
  content location; it globs for `{src/,}content` relative to this app).
  Authoring docs in the repo root lets a feature PR update its docs in the
  same commit.
- **`docs/architecture/`** (dev/agent notes) is excluded from the site three
  ways: hidden from the sidebar (`docs/_meta.js`), dropped from the export and
  search index (`app/[[...mdxPath]]/page.tsx`), and scrubbed from the
  serialized page map (`app/layout.tsx`).

## Commands

```sh
npm install
npm run dev     # serves the site on :3002
npm run build   # static export to out/ + Pagefind search index
```

Build the deployable image from the **repository root** (the content symlink
must resolve inside the build context):

```sh
docker build -f nextra/Dockerfile -t print-vault-docs .
```

The image is nginx serving the static export on port 80 — put the reverse
proxy for the docs subdomain in front of it.

## Why the `zod` override in package.json

`nextra`/`nextra-theme-docs` 4.6.1 declare `zod ^4.1.12`, but zod ≥ 4.4
rejects missing keys of `z.custom()` schemas before the custom check runs
("expected nonoptional, received undefined → at children"), and the theme's
`Layout` always validates its props with `children` stripped — every page
500s. The override pins the zod version the release was built against; drop
it when upgrading Nextra to a version that works against current zod.
