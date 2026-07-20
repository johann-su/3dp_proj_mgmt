# Model versioning & trash

*Read before adding any model mutation path, or touching trash/history. Update
in the same PR that changes this behaviour.*

(issue #55; `src/lib/model-versions.ts`, pure snapshot helpers in
`src/lib/version-snapshot.ts`): every completed model mutation (create, edit,
Onshape sync, revert) appends a `model_versions` row holding a full JSON
snapshot of the mutable state — title, description, category, tags, BOM, and
the ordered file list including each file's `s3Key`. `model_files` deliberately
keeps meaning **"the live files only"** (no query has to filter out historical
rows): removing a file deletes its row but *not* its S3 object, because earlier
snapshots still reference the key; the model page's History panel reverts to
any version (open to every signed-in user, like editing), re-inserting file
rows from the snapshot and appending a new version rather than rewriting
history. Each history entry also links to a read-only **version preview**
(`/models/{id}/versions/{versionId}`): the same ModelView as the model page,
fed from the snapshot (files, images, PDFs, title/description, tags, category,
BOM), with every mutating affordance disabled via `modelId: null` and just
Restore/Back actions. Historical files have no `model_files` row, so their
bytes are served by `/api/files/versions/[versionId]/[index]` — addressed by
version row + snapshot index (both immutable), authenticated like
`/api/files/[id]` (session or signed token; `versionFileSrc` in
`src/lib/file-token.ts` mints the tokened URLs next/image needs) and
deliberately under `/api/files/**` so `images.localPatterns` keeps covering it.

Versions are capped (`VERSION_CAP`, 30/model); pruning deletes only S3 objects
no remaining snapshot or live row references. Generated OpenSCAD variants are
excluded from snapshots on purpose (additive, individually deletable, cheap to
regenerate) — their bytes *are* deleted when their `.scad` source or the
variant itself is removed. Models predating the feature get their pre-edit
state recorded lazily on the next mutation (`ensureBaselineVersion`) — no data
migration.

**When adding a model mutation path**: run it in one transaction with
`ensureBaselineVersion` first and `recordVersion` last, S3-delete only the keys
those helpers return, and never delete a non-variant model file's S3 object
directly.

Deletion is a trash bin: `deleteModel` just sets `models.deleted_at`; every
listing hides trashed models (`deleted_at IS NULL` in
`list-queries`/`search`/`smart-collections` plus the collection member/cover
paths — **new model listings must add the same condition**); `/models/trash`
restores (clear `deleted_at`) or purges permanently — scoped to the viewer's
own models, except moderators/admins, who see the whole instance's trash — and
loading it purges models trashed longer than `TRASH_RETENTION_DAYS` (30) — the
same lazy no-scheduler pattern as the `import_jobs` heartbeat check.
