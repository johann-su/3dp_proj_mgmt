# Architecture notes

Per-subsystem design notes and their non-obvious contracts. Each file records
**decisions taken and why** — the gotchas that aren't visible in the code.

These are loaded **on demand**: read the relevant file before editing that
subsystem. They are deliberately *not* `@`-imported into `AGENTS.md` — that
would pull all of them into every agent session and undo the point of the
split. `AGENTS.md` keeps only the cross-cutting rules plus the index below.

**When you change a subsystem's behaviour, update its file in the same PR** —
these only stay useful if they move in lockstep with the code.

| Editing… | Read first |
|---|---|
| Auth, sessions, roles, access control | [`auth-and-access.md`](./auth-and-access.md) |
| Model mutations, versioning, trash | [`versioning.md`](./versioning.md) |
| Uploads, downloads, file tokens/images | [`files.md`](./files.md) |
| Platform import (.3mf, MakerWorld/Printables URL, source sync, collections) | [`import.md`](./import.md) |
| Onshape import/sync + API client | [`onshape.md`](./onshape.md) |
| Slicer estimates & "open in slicer" deep links | [`slicing.md`](./slicing.md) |
| OpenSCAD customizer / parametric models | [`openscad.md`](./openscad.md) |
| Search, homepage listing, categories | [`search-and-catalog.md`](./search-and-catalog.md) |
| OpenTelemetry, logging, metrics | [`observability.md`](./observability.md) |
| Icon-only buttons & other UI conventions | [`ui-conventions.md`](./ui-conventions.md) |

> Operator/user-facing docs (install, self-hosting, configuration) live
> elsewhere — see the top-level `README.md` and `docs/`. These files are for
> developers and agents working *on* the code.
