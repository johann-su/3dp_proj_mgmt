# Search, homepage listing & categories

*Read before touching search, the homepage feed, or category assignment. Update
in the same PR that changes this behaviour.*

## Categories are a fixed, keyword-tagged set

The seeded list (`src/lib/category-defaults.ts`) is the whole taxonomy; imports
never add categories (that would sprawl into duplicates). Each category carries
`keywords` matched by the pure `src/lib/category-suggest.ts` against a model's
title, tags and — strongest signal — the source platform's own category names
(MakerWorld's `categories` list leaf-first, Printables' `category.path`; both
flow through `ImportedProject.categories` into the create-form draft). The
keyword lists embed the MakerWorld taxonomy mapped onto ours, so source
categories rank existing ones instead of creating new ones. No model stays
uncategorized: the form preselects the live suggestion (fallback "Other") until
the user picks manually, the collection-import job assigns one on direct insert
(`pickCategoryId` in `src/lib/categories.ts`), the server actions fall back to
"Other" on null, and migration 0015 backfilled existing blanks. "Other" has no
keywords on purpose — it is only ever the fallback. Keyword defaults live in both
`category-defaults.ts` and migration `0015_category_keywords.sql`; keep them in
sync.

## Search

A dedicated `/search` page backed entirely by Postgres (no separate search
engine — kept simple and self-hostable). `src/lib/search.ts` runs one
keyset-paginated query over a `models UNION ALL collections` projection: fuzzy
matching uses `pg_trgm`'s `strict_word_similarity` (best word-boundary-aligned
match, so a short query like "tlon" matches the word "Talon" inside a longer
title — whole-string `similarity()`/`%` scores even an exact word below the 0.3
default and was the original bug) OR'd with an ILIKE substring fallback, and
relevance ranks on the same word similarity. Models match on title, description,
and their tags (an `EXISTS` over model_tags); collections match on title +
description only. The GIN trigram indexes still accelerate the ILIKE fallback.
Filters — type (models/collections), uploader, printer, filament (jsonb `@>`),
nozzle, and print-time bucket — apply to the model_files metadata via `EXISTS`;
any model-only filter drops collections from the union. Sort is relevance (falls
back to newest without a query), newest, oldest, most viewed, or most
downloaded, each with its own self-describing keyset cursor
(score/time/metric-based). "Most downloaded" sums `model_files.download_count`
per model — collections have no download metric to sum, so it's model-only like
the printer/filament/nozzle filters and degrades to newest for a
collections-only search. Views/downloads are fire-and-forget counters
(`src/lib/metrics.ts`: `models`/`collections` `view_count` bumped on page load,
`model_files.download_count` on file download). All URL/param parsing and the
cursor codec live in the DB-free `src/lib/search-params.ts` (unit-tested);
`pg_trgm` and the supporting indexes are created in migration `0008_search.sql`.

## Homepage listing

The homepage (`src/lib/list-queries.ts`) is the same kind of ranked `models
UNION ALL collections` listing — category filter plus a sort control (newest,
oldest, recently updated, most viewed, most downloaded) — and shares its
id-hydration step with search via `src/lib/catalog-hydrate.ts`; its own pure
sort/cursor parsing lives in `src/lib/feed-params.ts`. Its search box just
submits the query to `/search`.

## Back/Forward restores the scroll position

Both lists append pages client-side (`useInfiniteScroll`), so on Back the
server-rendered page holds only page one and the browser can't scroll back
to where the user was. `useListRestore` (`src/hooks/use-list-restore.ts`,
pure core + tests in `src/lib/list-restore.ts`) snapshots the loaded items,
cursor and scroll offset to `sessionStorage` and puts them back when a
history entry is *revisited*. Contracts worth knowing before touching it:

- **Revisit vs fresh visit is per history entry.** The first mount stamps an
  id into `history.state` via `replaceState`; Next's patched `replaceState`
  keeps it on that entry and new pushes start without one. So Back/Forward
  and reload restore, while a link (sidebar Home, a new sort or query) starts
  at the top. Pass a `restoreKey` that is unique per query — the feed uses
  `feed:<category>:<sort>`, search its results key.
- **`history.scrollRestoration` is `manual` on a list's entry only.** On
  `auto` the browser re-applies its own stale, clamped position after the
  page settles and undoes the restore. Pushed entries inherit the mode, so
  the cleanup sets it back to `auto` for the next page.
- **Scroll is recorded from scroll events while the URL is still the
  list's**, because Next scrolls the next page to the top before the list
  unmounts. The restore retries while the page grows (ResizeObserver) and
  stops on user input or after 2 s.
- **Snapshots expire after an hour** (stale lists, expiring file tokens in
  card image URLs) and only the 10 most recent are kept.
- Dev Strict Mode replays the effects; the restore path seeds what the
  cleanup saves so a replay can't overwrite the snapshot with page one.
