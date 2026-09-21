# /// script
# requires-python = ">=3.12"
#
# [tool.orcaslicer.plugin]
# name = "Print Vault"
# description = "Send a freshly sliced file back to its model in Print Vault, as a new revision."
# author = "Print Vault"
# version = "0.1.0"
# ///
"""Print Vault — the return leg of the slicer round-trip (issue #122).

Print Vault deep-links a `.3mf` *out* to OrcaSlicer. This plugin brings the
result back: it works out which catalogue model the open project came from,
asks whether to update it, and pushes the **project** — the process settings,
the filaments and colours, where the objects sit on which plate — as a new
versioned revision of that model's own `.3mf`. What it replaces is the manual
round trip: download the file, change it, save it, edit the model, upload it
again.

Why a plugin and not a post-processing script
---------------------------------------------
The first version of this was a post-processing script, and the mechanism was
the problem. That field lives on the *process preset*, while the push target is
a *model* — so a per-model token meant editing (and dirtying) your print
profile every time you sliced something else. A plugin is installed once,
keeps its credential in its own folder, and can ask the slicer which project
is open. Setup is per machine, not per model.

How the target is worked out
----------------------------
The checkpoint's `origin.txt` names the file the project was opened from, and
`orca.host.model()` adds every object's `input_file` (which for a project
assembled out of STLs is the STL, not the project) and the Bambu `design_id`
in the 3MF. A file the catalogue served is
byte-identical to the stored object, so the SHA-256 of what is on disk matches
`model_files.content_hash` on the server and `/api/slice-push/resolve` answers
with the model. Filename and design-id matches are offered as weaker
candidates; only a single hash match is ever pushed to without asking.

Where the project comes from
----------------------------
Not from the hook. `Step.psGCodePostProcess` hands over one plate's *G-code* on
a temporary path, with `ctx.print`/`ctx.object` both None — there is no project
file at that moment and no way to ask for one.

OrcaSlicer is writing one anyway. Auto backup (Preferences, on by default,
every 10 s) keeps a crash-recovery checkpoint of the open project next to the
temp G-code, holding every `Metadata/*.config` and the current
`3D/3dmodel.model` — everything except the meshes, which are still in the file
the project was opened from (named in the checkpoint's `origin.txt`).
Overlaying the first onto the second gives a complete project file in which
every part was written by OrcaSlicer itself. See "The project checkpoint"
below; that is what a sync pushes, and no 3MF writer of our own is involved.

Two consequences. The checkpoint is rewritten when the *model* changes, not
when a slice finishes, so its `slice_info` predictions can lag the newest
slice — the footer of the G-code the hook was handed is parsed as a fallback
and sent as metadata. And the push token must be stripped out of
`project_settings.config` on the way (strip_plugin_settings): OrcaSlicer keeps
plugin config in the *print* config, so the credential is sitting in there.

When the slicing hook fires
---------------------------
*When* it fires depends on the printer (BackgroundSlicingProcess.cpp):

  Bambu printers   right after each plate is sliced, inside the slicing step
                   (`if (m_fff_print->is_BBL_printer()) run_post_process_scripts(...)`),
                   once per plate, with the plate's temp path passed as BOTH
                   the artifact and the "output name" — which is why
                   `push_filename()` refuses to trust `ctx.output_name`
  everything else  from `finalize_gcode()`, i.e. on export or printer upload

Either way it needs the *process preset* to list this capability under Print
Settings -> Others -> Slicing Pipeline Plugin; `PluginHooks.cpp` and
`PostProcessor.cpp` both return immediately when `slicing_pipeline_plugin` is
empty. So the hook is the *notification* that a slice happened — the sync
window works without it, because the checkpoint is on disk either way.

The step can also fire more than once per slice (export and upload each run it
on their own working copy), and once per plate under "Slice all". All of those
firings describe one project and merge into one queued sync, which is why a
sync needs no batching to stay at one version per action.

The UI rule that shapes everything
----------------------------------
`SlicingPipelinePluginCapability` runs on the slicing worker thread, and the
docs are explicit: do not call `orca.host.ui.*` from there — the UI thread can
be blocked waiting on that worker, so a marshaled UI call can deadlock. The
"update the catalogue or keep it local?" question therefore *cannot* be asked
from the hook. Hence three modes:

  ask (default)  the hook queues the sync; you answer in the plugin's own
                 window ("Sync with Print Vault": Plugins -> Run, or the
                 Actions Speed Dial, where it can be pinned as a tile)
  auto           the hook syncs immediately when the match is unambiguous and
                 you have said "always" for that model; never asks
  off            capture nothing

`prompt_after_slice` additionally raises that window by itself once a slice
lands, from a short-lived thread (the hook may not touch the UI). Refreshes are
coalesced: slicing 18 plates fires the hook 18 times, and the first version of
this raised a modal dialog on each — eighteen stacked dialogs, each asking about
one plate. One window that grows a list is the same information without the
pile. That thread is the one piece of this that leans on undocumented timing;
it is off by default and reported upstream in OrcaSlicer discussion #14878.

Running it outside OrcaSlicer
-----------------------------
The same file is a stand-alone CLI (`python3 orca_print_vault_plugin_any.py
--help`), because OrcaSlicer 2.4.2 and Bambu Studio/PrusaSlicer have no plugin
system. There it behaves like the old post-processing script: pass it as a
post-processing command and it resolves and pushes the file it is handed.
Stdlib only — slicers ship no Python environment of their own.
"""

from __future__ import annotations

import glob
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile

# Present only inside OrcaSlicer. The same file doubles as a stand-alone CLI
# (see the bottom of this module), which is how it runs on the builds that have
# no plugin system yet — so every use of `orca` is guarded.
try:
    import orca
except ImportError:  # pragma: no cover - exercised by the CLI path
    orca = None

# --- Configuration ----------------------------------------------------------

DEFAULTS = {
    # Instance origin, e.g. "https://vault.example.com". No trailing slash.
    "url": "",
    # A push token from Settings -> Push from slicer ("pvpush_...").
    "token": "",
    # "ask" | "auto" | "off" — see the module docstring.
    "mode": "ask",
    # Bring the sync window up by itself after a slice, instead of waiting
    # for the user to run the sync capability. Off by default: the pipeline
    # hook may not legally touch the UI, so this is done from a separate
    # thread, which is the one piece of this that leans on undocumented timing.
    "prompt_after_slice": False,
    # Never copy a working G-code larger than this into the queue. A deferred
    # push has to keep its own copy (the slicer deletes the temp file), and a
    # runaway plate should not fill the user's disk.
    "max_queue_mb": 1024,
    # ...and never let the queue as a whole exceed this. One slice of an
    # 18-plate project is eighteen firings, each with its own copy.
    "max_queue_total_mb": 2048,
    # Models the user has said "always push this one" for: {model_id: True}.
    "always": {},
    # Where a project was pushed last time, keyed by content hash or name, so a
    # re-saved or renamed project still knows where it belongs.
    "remembered": {},
    # Folders scanned for already-exported sliced files, so the sync window
    # can push one without the slicing hook having run at all. Empty means the
    # defaults below.
    "export_dirs": [],
    # Fold the sliced G-code into the project file a sync pushes, as
    # Metadata/plate_<n>.gcode (the layout Bambu's own "export all plates
    # sliced file" writes), making the catalogue's copy printable as it stands.
    # Off by default: the project already carries the slicer's own per-plate
    # predictions, so estimates arrive without adding tens of MB per revision
    # to a model's 30-version history.
    "include_gcode": False,
}


def default_export_dirs() -> list[str]:
    """Where OrcaSlicer's "Export plate sliced file" lands by default. Only
    ever read, never written."""
    home = os.path.expanduser("~")
    return [os.path.join(home, "Downloads"), os.path.join(home, "Desktop")]

# Artifact suffixes that appear on a slicer's output, used when deriving a name
# (a Bambu-style export is called `.gcode.3mf`, so one splitext is not enough).
ALLOWED_SUFFIXES = (".gcode", ".3mf")

# What this plugin will actually send. A project only — never a raw `.gcode`,
# which would sit next to the model's file as a row that no preview, deep link
# or estimate can use, and would be superseded by the next sync anyway. The
# sliced G-code travels *inside* the project when `include_gcode` is on. The
# ingest endpoint still accepts `.gcode` for the stand-alone CLI on slicers
# with no checkpoint to read (see --push-gcode).
PUSH_SUFFIXES = (".3mf",)

HTTP_TIMEOUT = 120
PUSH_TIMEOUT = 900  # a few hundred MB over a home upload link
UPLOAD_BLOCK = 1 << 20

# Config values read from the slicer at post-process time. Only these keys are
# ever sent: the point is what the G-code footer cannot say (which machine,
# which plate, which filaments), not a dump of the whole profile.
CONFIG_KEYS = {
    "printer_model": "model",
    "printer_settings_id": None,  # handled as a preset name
    "nozzle_diameter": "nozzleDiameterMm",
    "curr_bed_type": "bedType",
    "filament_type": "filamentTypes",
    "filament_colour": "filamentColors",
    "enable_support": "usesSupport",
}


def log(message: str) -> None:
    """Everything on stderr: PrusaSlicer-family slicers read a post-processing
    script's *stdout* back as a replacement output path."""
    print(f"[print-vault] {message}", file=sys.stderr, flush=True)


def sha256_file(path: str, limit_bytes: int = 2 << 30) -> str | None:
    """SHA-256 of a file on disk, or None if it can't be read. Matches
    model_files.content_hash, which is a hash of the stored bytes."""
    try:
        if os.path.getsize(path) > limit_bytes:
            return None
        digest = hashlib.sha256()
        with open(path, "rb") as handle:
            for block in iter(lambda: handle.read(1 << 20), b""):
                digest.update(block)
        return digest.hexdigest()
    except OSError:
        return None


# --- Talking to the instance ------------------------------------------------


class VaultError(Exception):
    """Anything that stopped a call from succeeding, with a message meant for
    a human. Never raised out of a slicing hook."""


class _ProgressReader:
    """File wrapper that reports upload progress. http.client pulls the body
    in blocks, so counting reads is counting bytes on the wire."""

    def __init__(self, handle, total: int, on_progress):
        self._handle = handle
        self._total = total
        self._sent = 0
        self._on_progress = on_progress

    def read(self, size: int = -1) -> bytes:
        chunk = self._handle.read(size)
        self._sent += len(chunk)
        if self._on_progress and self._total > 0:
            # Report a fraction, so the caller decides what a progress bar or a
            # log line looks like.
            self._on_progress(min(1.0, self._sent / self._total))
        return chunk


class VaultClient:
    def __init__(self, url: str, token: str):
        self.url = (url or "").rstrip("/")
        self.token = (token or "").strip()

    def configured(self) -> bool:
        return bool(self.url and self.token)

    def _request(self, method: str, path: str, *, data=None, headers=None, timeout=HTTP_TIMEOUT):
        if not self.configured():
            raise VaultError("Print Vault is not set up yet — add the instance URL and a push token.")
        target = path if path.startswith("http") else f"{self.url}{path}"
        request = urllib.request.Request(target, data=data, method=method)
        request.add_header("Authorization", f"Bearer {self.token}")
        request.add_header("User-Agent", "print-vault-orca-plugin/0.1")
        for key, value in (headers or {}).items():
            request.add_header(key, value)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read()
        except urllib.error.HTTPError as err:
            # 401 is by far the most common failure and deserves its own
            # sentence; everything else reports the status it got.
            if err.code == 401:
                raise VaultError("The push token was rejected — it may have been revoked.") from err
            detail = ""
            try:
                detail = json.loads(err.read().decode("utf-8", "replace")).get("error", "")
            except Exception:
                pass
            raise VaultError(f"Print Vault answered {err.code}{f': {detail}' if detail else ''}") from err
        except urllib.error.URLError as err:
            raise VaultError(f"Could not reach {self.url}: {err.reason}") from err
        if not body:
            return {}
        try:
            return json.loads(body.decode("utf-8", "replace"))
        except ValueError:
            return {}

    def ping(self) -> dict:
        return self._request("GET", "/api/slice-push/ping")

    def resolve(
        self,
        hashes: list[str],
        filenames: list[str],
        design_id: str | None,
        query: str | None = None,
    ) -> list[dict]:
        payload = json.dumps(
            {
                "hashes": hashes,
                "filenames": filenames,
                "designId": design_id,
                "query": query,
            }
        ).encode("utf-8")
        answer = self._request(
            "POST",
            "/api/slice-push/resolve",
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        return answer.get("candidates", [])

    def push(
        self,
        model_id: str,
        path: str,
        filename: str,
        meta: dict | None,
        on_progress=None,
        replaces: str | None = None,
        batch: str | None = None,
        batch_final: bool = False,
    ) -> dict:
        """Uploads the artifact as a new revision of `model_id`. Streams from
        disk — a sliced G-code is routinely hundreds of MB and must never be
        read into memory."""
        size = os.path.getsize(path)
        # `replaces` names the file this is a new revision *of*, so the server
        # keeps that file's name instead of adding a row named after a slicer
        # temp file. It is a hint: a mismatched artifact falls back to a
        # filename match server-side.
        params = {"filename": filename}
        if replaces:
            params["replaces"] = replaces
        # One "Slice all" is one push per plate; `batch` tells the server to
        # record a single version for the lot instead of one per plate.
        if batch:
            params["batch"] = batch
            if batch_final:
                params["batchFinal"] = "1"
        query = urllib.parse.urlencode(params)
        headers = {
            "Content-Type": "application/octet-stream",
            "Content-Length": str(size),
        }
        if meta:
            headers["X-Slice-Push-Meta"] = json.dumps(meta, separators=(",", ":"))
        with open(path, "rb") as handle:
            body = _ProgressReader(handle, size, on_progress) if on_progress else handle
            return self._request(
                "POST",
                f"/api/models/{model_id}/slice-push?{query}",
                data=body,
                headers=headers,
                timeout=PUSH_TIMEOUT,
            )


# --- Shared state -----------------------------------------------------------
#
# The two capabilities (the slicing hook and the sync window) are separate
# objects the host constructs, so they share through this module-level
# singleton rather than through a constructor. The hook registers itself on
# load so the window can read and write the one config the user actually edits.


class State:
    def __init__(self):
        self.lock = threading.RLock()
        # The slicing-pipeline capability instance, once loaded. It owns the
        # stored config; the window borrows it so there is a single source of
        # truth even though every capability has its own config slot.
        self.config_owner = None
        # The sync capability instance, so the hook can raise its window
        # without owning any UI itself.
        self.window = None
        self._storage: str | None = None
        self._notify_thread: threading.Thread | None = None
        self._notify_at = 0.0

    # --- storage ---

    def storage_dir(self) -> str:
        """The plugin's own folder. Falls back to a temp dir outside
        OrcaSlicer so the CLI path works too."""
        with self.lock:
            if self._storage:
                return self._storage
            try:
                self._storage = orca.host.plugin.storage()  # type: ignore[name-defined]
            except Exception:
                self._storage = os.path.join(
                    os.path.expanduser("~"), ".print-vault-orca"
                )
            os.makedirs(os.path.join(self._storage, "queue"), exist_ok=True)
            return self._storage

    def queue_dir(self) -> str:
        return os.path.join(self.storage_dir(), "queue")

    def sync_dir(self) -> str:
        """Scratch space for assembled project files. Each one is deleted as
        soon as its push finishes; anything left here is the debris of a push
        that failed, and is cleared on load."""
        path = os.path.join(self.storage_dir(), "sync")
        os.makedirs(path, exist_ok=True)
        return path

    def sync_clear(self) -> None:
        for name in os.listdir(self.sync_dir()):
            try:
                os.remove(os.path.join(self.sync_dir(), name))
            except OSError:
                pass

    def settings_path(self) -> str:
        return os.path.join(self.storage_dir(), "settings.json")

    # --- settings ---

    def settings(self) -> dict:
        """Effective settings: the capability's stored config when the hook is
        loaded, else the mirror on disk (which is what the CLI reads, and what
        survives the hook being disabled)."""
        merged = dict(DEFAULTS)
        try:
            with open(self.settings_path(), "r", encoding="utf-8") as handle:
                merged.update(json.load(handle))
        except (OSError, ValueError):
            pass
        owner = self.config_owner
        if owner is not None:
            try:
                stored = json.loads(owner.get_config() or "{}")
                if isinstance(stored, dict) and stored:
                    # A token typed into the Config tab is honoured, but an
                    # empty one is "no opinion", not "no token": the capability
                    # config deliberately does not keep it (see save_settings).
                    if not stored.get("token"):
                        stored.pop("token", None)
                    merged.update(stored)
            except Exception:
                pass
        return merged

    def save_settings(self, values: dict) -> None:
        """Persists to both places: the capability config (what the Config tab
        shows) and the on-disk mirror (what the window and the CLI read).

        **The token only goes to disk.** OrcaSlicer keeps a capability's config
        in the *print config* (`print_plugin_config_overrides`), which is saved
        with your process preset and written into every project you save or
        export — so a token left there is a long-lived write credential for
        your instance, in plaintext, inside files you hand to other people.
        The plugin's own folder is not serialized into anything.
        """
        merged = dict(self.settings())
        merged.update(values)
        with self.lock:
            owner = self.config_owner
            if owner is not None:
                try:
                    owner.save_config(json.dumps({**merged, "token": ""}))
                except Exception as exc:
                    log(f"could not save capability config: {exc}")
            try:
                with open(self.settings_path(), "w", encoding="utf-8") as handle:
                    json.dump(merged, handle, indent=2)
            except OSError as exc:
                log(f"could not write settings.json: {exc}")

    def migrate_token_out_of_config(self) -> None:
        """Move a token stored in the capability config onto disk.

        Earlier versions of this plugin saved it in both places, and the
        capability config is part of the **print** config: OrcaSlicer writes it
        into your process preset and into every project you save or export
        while the hook is enabled. Rewriting the config without it is the only
        way the old copy leaves.
        """
        owner = self.config_owner
        if owner is None:
            return
        try:
            stored = json.loads(owner.get_config() or "{}")
        except Exception:
            return
        if not isinstance(stored, dict) or not stored.get("token"):
            return
        log("moving the push token out of the print profile into the plugin's own folder")
        self.save_settings({"token": stored["token"]})

    def notify_queued(self) -> None:
        """Bring the sync window up (or refresh it) after a slice.

        Coalesced on purpose. Slicing 18 plates fires the hook 18 times, and
        the first version of this raised a modal each time — eighteen stacked
        dialogs over the plater, each demanding an answer about one plate. One
        window that grows a list is the same information without the pile.

        Runs on its own thread because the hook may not touch the UI (the
        slicing worker can be the thread the UI is waiting on), and the delay
        also lets several plates land in one refresh.
        """
        with self.lock:
            self._notify_at = time.time() + 1.5
            if self._notify_thread is not None and self._notify_thread.is_alive():
                return  # a pass is already scheduled; it will pick this up

            def run():
                while True:
                    with self.lock:
                        wait = self._notify_at - time.time()
                    if wait <= 0:
                        break
                    time.sleep(min(wait, 1.0))
                window = self.window
                if window is None:
                    log("sync capability is not enabled; slices are queued only")
                    return
                try:
                    window.show()
                except Exception as exc:  # noqa: BLE001
                    log(f"could not open the sync window: {exc}")

            self._notify_thread = threading.Thread(
                target=run, name="print-vault-notify", daemon=True
            )
            self._notify_thread.start()

    def client(self) -> VaultClient:
        settings = self.settings()
        return VaultClient(settings.get("url", ""), settings.get("token", ""))

    # --- the pending queue ---
    #
    # One entry per project waiting to be synced: a JSON sidecar describing the
    # checkpoint, plus (only when `include_gcode` is on) a copy of each plate's
    # G-code, since the file the hook is handed is a working copy the slicer
    # deletes once the export finishes.

    def queue_put(self, entry: dict) -> dict:
        """Queue an entry that owns no artifact.

        A sync entry points at OrcaSlicer's live project checkpoint instead of
        at a copy of anything: the bytes are assembled when the push runs, out
        of files the slicer is maintaining anyway. Nothing to copy, and nothing
        for the size caps to bound.
        """
        entry_id = entry.get("id") or uuid.uuid4().hex
        entry = {**entry, "id": entry_id, "queuedAt": entry.get("queuedAt") or time.time()}
        try:
            with open(os.path.join(self.queue_dir(), f"{entry_id}.json"), "w", encoding="utf-8") as handle:
                json.dump(entry, handle, indent=2)
        except OSError as exc:
            log(f"could not write queue entry: {exc}")
            return entry
        self.queue_trim()
        return entry

    def queue_upsert_sync(self, entry: dict) -> dict:
        """One entry per project, not one per plate.

        "Slice all" fires the hook once per plate and every firing describes
        the same project: the same checkpoint, the same target, one file to
        push. Merging into the entry that is already there is what makes an
        18-plate slice a single card with a single button — and why a sync
        needs none of the batch machinery a per-plate G-code push does.
        """
        key = entry.get("origin") or entry.get("checkpoint")
        with self.lock:
            for existing in self.queue_list():
                if existing.get("kind") != "sync":
                    continue
                if (existing.get("origin") or existing.get("checkpoint")) != key:
                    continue
                return self.queue_put(
                    {
                        **existing,
                        **entry,
                        "id": existing["id"],
                        "gcode": {**existing.get("gcode", {}), **entry.get("gcode", {})},
                        "plates": sorted(
                            {*existing.get("plates", []), *entry.get("plates", [])}
                        ),
                        # Per plate, newest reading of each: the total across
                        # them is the project's estimate.
                        "plateStats": {
                            **existing.get("plateStats", {}),
                            **entry.get("plateStats", {}),
                        },
                    }
                )
            return self.queue_put(entry)

    def queue_list(self) -> list[dict]:
        entries = []
        try:
            names = sorted(os.listdir(self.queue_dir()))
        except OSError:
            return entries
        for name in names:
            if not name.endswith(".json"):
                continue
            try:
                with open(os.path.join(self.queue_dir(), name), "r", encoding="utf-8") as handle:
                    entry = json.load(handle)
            except (OSError, ValueError):
                continue
            # A queue entry whose artifact is gone is noise, not history. A
            # sync entry has no artifact of its own; what it needs to still be
            # there is the checkpoint it describes (a closed project, or one
            # OrcaSlicer restarted since, has none).
            alive = (
                os.path.isdir(entry.get("checkpoint", ""))
                if entry.get("kind") == "sync"
                else os.path.exists(entry.get("path", ""))
            )
            if alive:
                entries.append(entry)
            else:
                self.queue_remove(entry.get("id", ""))
        entries.sort(key=lambda e: e.get("queuedAt", 0), reverse=True)
        return entries

    def queue_get(self, entry_id: str) -> dict | None:
        return next((e for e in self.queue_list() if e.get("id") == entry_id), None)

    def queue_remove(self, entry_id: str) -> None:
        # Everything an entry owns is named after it: the sidecar, and (for a
        # G-code entry, or a sync that kept its plates) one file per artifact.
        if not entry_id:
            return
        try:
            names = os.listdir(self.queue_dir())
        except OSError:
            return
        for name in names:
            if not name.startswith(entry_id):
                continue
            try:
                os.remove(os.path.join(self.queue_dir(), name))
            except OSError:
                pass

    def queue_keep_gcode(self, entry_id: str, plate: int, source_path: str, max_bytes: int) -> str | None:
        """Keep a plate's G-code for a sync that will embed it.

        Named after the entry so queue_remove takes it with the sidecar. The
        slicer deletes its working copy once the export finishes, so a deferred
        sync that promises to carry the G-code has to copy it now.
        """
        try:
            size = os.path.getsize(source_path)
        except OSError:
            return None
        if size > max_bytes:
            log(
                f"not keeping plate {plate}'s G-code: {size // (1 << 20)} MB exceeds the "
                f"{max_bytes // (1 << 20)} MB limit (raise max_queue_mb, or turn include_gcode off)"
            )
            return None
        stored = os.path.join(self.queue_dir(), f"{entry_id}_plate_{plate}.gcode")
        try:
            shutil.copyfile(source_path, stored)
        except OSError as exc:
            log(f"could not keep plate {plate}'s G-code: {exc}")
            return None
        return stored

    def queue_trim(self, keep: int = 10) -> None:
        """Bounded twice over: by count, and by total bytes.

        The queue holds copies of very large files — a multi-plate project
        fires the hook once per plate — and a slice nobody answered for a week
        is not worth the disk. Newest entries win; the oldest are dropped.
        """
        budget = int(self.settings().get("max_queue_total_mb", 2048)) * (1 << 20)
        used = 0
        for index, entry in enumerate(self.queue_list()):
            used += entry.get("size", 0)
            if index >= keep or used > budget:
                self.queue_remove(entry.get("id", ""))


STATE = State()


# --- Reading the open project ----------------------------------------------
#
# Everything here is best-effort and wrapped: the host API is experimental, and
# a plugin that raises during a slice is worse than a plugin that pushes
# nothing. All of it is read-only.

_HASH_CACHE: dict[tuple[str, int, int], str] = {}


def _cached_hash(path: str) -> str | None:
    """Hashing the opened project on every slice would add seconds to a
    re-slice, so results are keyed on (path, mtime, size) — the same triple a
    build system would use."""
    try:
        stat = os.stat(path)
    except OSError:
        return None
    key = (path, int(stat.st_mtime), stat.st_size)
    if key not in _HASH_CACHE:
        digest = sha256_file(path)
        if digest is None:
            return None
        # Bounded: one entry per file the user has opened this session.
        if len(_HASH_CACHE) > 64:
            _HASH_CACHE.clear()
        _HASH_CACHE[key] = digest
    return _HASH_CACHE[key]


def strip_copy_suffix(name: str) -> str:
    """"fuselage(7).3mf" -> "fuselage.3mf".

    Everything that hands a file around adds one of these: browsers append
    " (1)", OrcaSlicer appends "(7)" when you save a project again. The file
    is still the same design, so the name it *would* have had is worth
    offering as a weaker match."""
    stem, ext = os.path.splitext(os.path.basename(name))
    cleaned = re.sub(r"[\s_-]*\(\d+\)\s*$", "", stem).strip()
    return f"{cleaned}{ext}" if cleaned else os.path.basename(name)


def remember_key(identity: dict) -> str | None:
    """How a project is recognised again next time. The content hash when we
    have one; otherwise the name — a project that gets re-saved changes its
    hash, and that is exactly the case this exists for."""
    if identity.get("hashes"):
        return f"h:{identity['hashes'][0]}"
    if identity.get("filenames"):
        return f"n:{strip_copy_suffix(identity['filenames'][0]).lower()}"
    return None


def remembered_target(identity: dict) -> dict | None:
    """The model this project was pushed to last time.

    The catalogue cannot recognise a project the user re-saved (new bytes, new
    name), so once they have told us where it goes, that answer is kept. It is
    treated as a confident match: it is a human decision about this exact
    file, which is stronger evidence than any heuristic here.
    """
    key = remember_key(identity)
    if not key:
        return None
    target = STATE.settings().get("remembered", {}).get(key)
    return {**target, "via": "remembered"} if isinstance(target, dict) else None


def remember_target(identity: dict, candidate: dict) -> None:
    key = remember_key(identity)
    if not key or not candidate.get("modelId"):
        return
    remembered = dict(STATE.settings().get("remembered", {}))
    remembered[key] = {
        "modelId": candidate["modelId"],
        "modelTitle": candidate.get("modelTitle", "this model"),
        "fileId": candidate.get("fileId"),
    }
    # Bounded: one entry per project someone has ever pushed from.
    if len(remembered) > 200:
        remembered.pop(next(iter(remembered)))
    STATE.save_settings({"remembered": remembered})


def collect_identity() -> dict:
    """What the open project can tell us about where it came from: the files it
    was loaded from (hashed), their names, and the Bambu design id."""
    identity: dict = {"hashes": [], "filenames": [], "designId": None}
    try:
        model = orca.host.model()  # type: ignore[name-defined]
    except Exception as exc:
        log(f"could not read the open project: {exc}")
        return identity

    try:
        design_id = model.design_id()
        identity["designId"] = design_id or None
    except Exception:
        pass

    seen: set[str] = set()
    try:
        objects = model.objects()
    except Exception:
        objects = []
    for obj in objects:
        try:
            path = obj.input_file
        except Exception:
            continue
        if not path or path in seen:
            continue
        seen.add(path)
        name = os.path.basename(path)
        identity["filenames"].append(name)
        # "fuselage(7).3mf" is still the file the catalogue calls
        # "fuselage.3mf"; offer both so a re-saved project still matches.
        stripped = strip_copy_suffix(name)
        if stripped != name:
            identity["filenames"].append(stripped)
        digest = _cached_hash(path)
        if digest:
            identity["hashes"].append(digest)
    return identity


def _cfg(ctx, key: str) -> str | None:
    try:
        value = ctx.config_value(key)
    except Exception:
        return None
    if value is None:
        return None
    return str(value)


def _as_list(value: str | None) -> list[str]:
    """Per-extruder options arrive serialized ("PLA;PETG" / "0.4,0.4")."""
    if not value:
        return []
    parts = [p.strip().strip('"') for p in value.replace(",", ";").split(";")]
    return [p for p in parts if p]


def _meta_from(get) -> dict:
    """Shared by both metadata paths: `get(key) -> str | None`. The slicing hook
    reads the config off its context; the sync window reads it off the live
    preset bundle, since there is no context there."""
    meta: dict = {}

    model = get("printer_model")
    if model:
        meta["model"] = model
    bed = get("curr_bed_type")
    if bed:
        meta["bedType"] = bed
    nozzles = _as_list(get("nozzle_diameter"))
    if nozzles:
        try:
            meta["nozzleDiameterMm"] = float(nozzles[0])
        except ValueError:
            pass
    filaments = _as_list(get("filament_type"))
    if filaments:
        meta["filamentTypes"] = filaments
        colours = _as_list(get("filament_colour"))
        if len(colours) == len(filaments):
            meta["filamentColors"] = colours
    support = get("enable_support") or get("support_material")
    if support is not None:
        meta["usesSupport"] = support.lower() in ("1", "true", "yes")

    # Preset *names*, read live from the slicer — nothing embedded in a file
    # would give us these, and they are what someone needs to reproduce the
    # print. Read-only, and non-fatal if the API moves.
    try:
        bundle = orca.host.preset_bundle()  # type: ignore[name-defined]
        presets = {
            "printer": bundle.printers.get_selected_preset_name(),
            "process": bundle.prints.get_selected_preset_name(),
            "filaments": list(bundle.current_filament_preset_names()),
        }
        meta["presets"] = {k: v for k, v in presets.items() if v}
    except Exception:
        pass
    return meta


def collect_meta(ctx) -> dict:
    """The context the G-code footer does not carry: machine, nozzle, plate,
    filament slots and the presets that produced the file. Sent in a header and
    folded into the model file's printer info server-side."""
    return _meta_from(lambda key: _cfg(ctx, key))


def collect_meta_host() -> dict:
    """Same, read off the live preset bundle — what the sync window has when
    it pushes a file the hook never saw."""
    try:
        bundle = orca.host.preset_bundle()  # type: ignore[name-defined]
    except Exception:
        return {}

    def get(key: str) -> str | None:
        try:
            value = bundle.full_config_value(key)
        except Exception:
            return None
        return None if value is None else str(value)

    return _meta_from(get)


def recent_exports(dirs: list[str], limit: int = 12, max_age_hours: int = 72) -> list[dict]:
    """Sliced files sitting in the user's export folders, newest first.

    The escape hatch from OrcaSlicer's one real constraint here: a
    slicing-pipeline capability only runs when the *process preset* lists it
    (`slicing_pipeline_plugin`), so a preset that has never been wired up
    produces nothing to review. Scanning where exports land needs no preset at
    all — the file is already on disk, and it is the same artifact the hook
    would have handed over.
    """
    cutoff = time.time() - max_age_hours * 3600
    found: list[dict] = []
    for directory in dirs or default_export_dirs():
        try:
            names = os.listdir(directory)
        except OSError:
            continue
        for name in names:
            if not name.lower().endswith(PUSH_SUFFIXES):
                continue
            path = os.path.join(directory, name)
            try:
                stat = os.stat(path)
            except OSError:
                continue
            if not os.path.isfile(path) or stat.st_mtime < cutoff:
                continue
            found.append(
                {
                    "path": path,
                    "filename": name,
                    "sizeMb": round(stat.st_size / (1 << 20), 1),
                    "mtime": stat.st_mtime,
                    # Always a project: `.gcode` is not offered, because a
                    # plate of G-code cannot revise the model's file.
                    "kind": "project",
                }
            )
    found.sort(key=lambda item: item["mtime"], reverse=True)
    return found[:limit]


def file_id_for(candidates: list[dict], model_id: str) -> str | None:
    """The catalogue file the chosen model was matched through, if any — what
    the push replaces so the revision keeps that file's name."""
    for candidate in candidates or []:
        if candidate.get("modelId") == model_id and candidate.get("fileId"):
            return candidate["fileId"]
    return None


def current_plate() -> int | None:
    """1-based index of the plate on the plater, for naming a per-plate export.
    Best effort: under "Slice all" the plater's idea of the current plate may
    lag the plate being sliced, which is one more reason the sync window
    shows the name before anything is pushed."""
    try:
        return int(orca.host.model().current_plate_index()) + 1  # type: ignore[name-defined]
    except Exception:
        return None


# --- The project checkpoint -------------------------------------------------
#
# The hook hands over one plate's G-code and nothing else (see the module
# docstring) — but OrcaSlicer is writing a full project snapshot to disk the
# whole time anyway. Preferences -> Auto backup (`backup_switch`, on by
# default, `backup_interval` 10 s) keeps a crash-recovery copy of the open
# project in
#
#   <temp>/orcaslicer_<uid>/orcaslicer_model/<Day_Mon_D>/<HH_MM_SS>#<pid>#<n>/
#     .3mf          Orca's own 3MF writer: 3D/3dmodel.model (+ rels) and every
#                   Metadata/*.config — process settings, filament and colour
#                   assignment, plate layout, per-object overrides, and the
#                   live slice predictions. Everything except the meshes.
#     origin.txt    the path the project was loaded from
#     lock.txt      the pid that owns it
#     3D/Objects/   mesh parts, written only for objects edited or added here
#     Auxiliaries/  the project's own files (manuals, pictures), loose
#     Metadata/.<pid>.<n>.gcode   the sliced plates — what the hook is handed
#
# That is the other half of the round trip. The checkpoint holds the changes;
# the file the project was loaded from holds the meshes; overlaying one on the
# other produces a complete project file whose every part was written by
# OrcaSlicer itself. No 3MF writer of our own, and nothing for the user to
# export by hand.
#
# Two properties worth holding on to. The hook's artifact lives *inside* the
# checkpoint (`Metadata/.<pid>.<n>.gcode`), so the hook finds the directory by
# walking up from `ctx.gcode_path` — no searching. And the checkpoint is
# rewritten when the *model* changes, not when a slice finishes, so its
# `slice_info` can lag the newest slice: hence the footer numbers below, sent
# as metadata so the server has an estimate either way.

# Where a checkpoint directory can turn up, relative to a temp root. Orca and
# Bambu Studio name theirs after the app; the bare form covers builds that
# drop the per-user level.
CHECKPOINT_GLOBS = (
    os.path.join("orcaslicer_*", "orcaslicer_model", "*", "*"),
    os.path.join("orcaslicer_model", "*", "*"),
    os.path.join("bambustudio_*", "bambustudio_model", "*", "*"),
)

# Loose directories in a checkpoint that belong in the project file. Whatever
# else is in there is either inside the `.3mf` already or slicer scratch: the
# temp per-plate G-code, and the plate thumbnails copied in when the project
# was opened.
CHECKPOINT_TREES = ("3D/Objects", "Auxiliaries")

PROJECT_SETTINGS_PART = "Metadata/project_settings.config"
MODEL_PART = "3D/3dmodel.model"
CONTENT_TYPES_PART = "[Content_Types].xml"

# What the ingest route accepts (MAX_PUSH_BYTES in its own source). Checked
# before the upload so a project that cannot land fails in a sentence rather
# than after a few hundred MB.
MAX_PUSH_BYTES = 256 * 1024 * 1024

# How much of each end of a G-code file to read. Which end carries which
# number depends on the slicer: OrcaSlicer on a Bambu printer writes the print
# time on line 3 and the filament totals at the end. Mirrors GCODE_HEAD_BYTES
# and GCODE_TAIL_BYTES in src/lib/gcode-stats.ts.
GCODE_HEAD_BYTES = 64 * 1024
GCODE_TAIL_BYTES = 128 * 1024

_UNIT_SECONDS = {"d": 86400, "h": 3600, "m": 60, "s": 1}

# The two slicer families spell every one of these differently: PrusaSlicer
# (and OrcaSlicer, which inherits its G-code writer) writes `key = value`,
# Bambu Studio writes `key: value` — and puts both of its times on one line,
# `; model printing time: 4h 53m 23s; total estimated time: 5h 0m 4s`, which is
# why every capture stops at a `;` rather than at the end of the line. Kept in
# step with the canonical list in src/lib/gcode-stats.ts — add a dialect
# *there* first.
_TIME_PATTERNS = (
    re.compile(r"^; estimated printing time.*?=\s*([^;\n]+)", re.M),
    re.compile(r"^;[^\n]*?total estimated time:\s*([^;\n]+)", re.M),
    re.compile(r"^; model printing time:\s*([^;\n]+)", re.M),
)
_GRAMS_PATTERNS = (
    re.compile(r"^; total filament used \[g\]\s*=\s*([^;\n]+)", re.M),
    re.compile(r"^; filament used \[g\]\s*=\s*([^;\n]+)", re.M),
    re.compile(r"^; total filament weight \[g\]\s*:\s*([^;\n]+)", re.M),
    re.compile(r"^; filament weight \[g\]\s*:\s*([^;\n]+)", re.M),
)


def _read_text(path: str, limit: int = 4096) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read(limit).strip()
    except OSError:
        return ""


def _checkpoint_roots() -> list[str]:
    """Temp roots to look for a checkpoint under. `gettempdir()` is the real
    answer on every platform; the rest are cheap to try and cover a slicer
    started with a different TMPDIR than this process inherited."""
    roots = [tempfile.gettempdir()]
    for extra in ("/tmp", os.environ.get("TMP", ""), os.environ.get("TEMP", "")):
        if extra and os.path.isdir(extra) and extra not in roots:
            roots.append(extra)
    return roots


def checkpoint_at(directory: str) -> dict | None:
    """Describe a checkpoint directory, or None when it is not one.

    The project file is literally named `.3mf` (Orca appends nothing to the
    empty project name); older builds and Bambu Studio name it after the
    project, so the newest `*.3mf` in the folder is the fallback.

    A directory can be a checkpoint and hold **no project snapshot yet**:
    opening a project creates the folder, `origin.txt` and `lock.txt`, and the
    `.3mf` is written on the first change after that. `project` is None then,
    and `ready` is False — a distinct state from "there is no checkpoint at
    all", which means Auto backup is switched off. Reporting the second when
    it is the first sends people to a preference that is already on.
    """
    if not directory or not os.path.isdir(directory):
        return None
    project: str | None = os.path.join(directory, ".3mf")
    if not os.path.isfile(project):
        named = [p for p in glob.glob(os.path.join(directory, "*.3mf")) if os.path.isfile(p)]
        project = max(named, key=os.path.getmtime) if named else None
    lock = _read_text(os.path.join(directory, "lock.txt"), 32)
    origin = _read_text(os.path.join(directory, "origin.txt"), 4096)
    if project is None and not (lock or origin):
        return None  # not a checkpoint directory at all
    try:
        mtime = os.path.getmtime(project or directory)
    except OSError:
        return None
    return {
        "dir": directory,
        "project": project,
        "ready": project is not None,
        "origin": origin or None,
        "pid": int(lock) if lock.isdigit() else None,
        "mtime": mtime,
    }


def project_checkpoint(gcode_path: str | None = None) -> dict | None:
    """The checkpoint of the project open in *this* OrcaSlicer, or None.

    From the hook the answer is free: the artifact it was handed is
    `<checkpoint>/Metadata/.<pid>.<n>.gcode`. From the window there is no
    context, so the temp roots are scanned and the pid in `lock.txt` decides —
    a second OrcaSlicer window keeps its own checkpoint, and pushing one
    project's settings onto another project's model is exactly the mistake
    with no cheap undo.
    """
    if gcode_path:
        found = checkpoint_at(os.path.dirname(os.path.dirname(os.path.abspath(gcode_path))))
        if found:
            return found
    pid = os.getpid()
    best: dict | None = None
    for root in _checkpoint_roots():
        for pattern in CHECKPOINT_GLOBS:
            for directory in glob.glob(os.path.join(root, pattern)):
                found = checkpoint_at(directory)
                if not found or found["pid"] != pid:
                    continue
                if best is None or found["mtime"] > best["mtime"]:
                    best = found
    return best


def checkpoint_plates(checkpoint: dict) -> list[int]:
    """Plate indices the checkpoint's slice_info carries predictions for.
    Only used to describe the sync in the window ("6 plates")."""
    if not checkpoint.get("project"):
        return []
    try:
        with zipfile.ZipFile(checkpoint["project"]) as archive:
            info = archive.read("Metadata/slice_info.config").decode("utf-8", "replace")
    except (OSError, KeyError, zipfile.BadZipFile):
        return []
    plates = []
    for chunk in info.split("<plate>")[1:]:
        match = re.search(r'key="index"\s+value="(\d+)"', chunk)
        if match:
            plates.append(int(match.group(1)))
    return sorted(set(plates))


def checkpoint_identity(identity: dict, checkpoint: dict | None) -> dict:
    """Add the file the project was *opened from* to what resolve is asked about.

    `collect_identity()` can only see each object's `input_file`, which for a
    project assembled from STLs is the STL path — nothing this catalogue ever
    served. `origin.txt` names the `.3mf` itself, which is the one file the
    instance is likely to have a content hash for.
    """
    origin = (checkpoint or {}).get("origin")
    if not origin or not os.path.isfile(origin):
        return identity
    merged = {
        "hashes": list(identity.get("hashes", [])),
        "filenames": list(identity.get("filenames", [])),
        "designId": identity.get("designId"),
    }
    name = os.path.basename(origin)
    # Inserted at the front, best last, so the raw name ends up first: the
    # name of the file the catalogue served is also what a push is named after.
    for candidate in (strip_copy_suffix(name), name):
        if candidate and candidate in merged["filenames"]:
            merged["filenames"].remove(candidate)
        if candidate:
            merged["filenames"].insert(0, candidate)
    digest = _cached_hash(origin)
    if digest:
        if digest in merged["hashes"]:
            merged["hashes"].remove(digest)
        merged["hashes"].insert(0, digest)
    return merged


def parse_gcode_stats(path: str) -> dict:
    """Print time (seconds) and filament weight (g) from a G-code footer.

    This parsing normally happens server-side (src/lib/gcode-stats.ts reads a
    pushed `.gcode` as it streams to storage). A *synced project* ships no
    G-code, so when the checkpoint's own predictions are stale these numbers
    are the only estimate there is, and here is the only place that can read
    them.

    Both ends of the file are read: OrcaSlicer on a Bambu printer writes the
    print time in the header and the filament totals in the footer.
    """
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as handle:
            # latin-1: a window starts and ends mid-file, so a multi-byte
            # character can be cut in half, and every pattern above is ASCII.
            text = handle.read(min(size, GCODE_HEAD_BYTES)).decode("latin-1")
            if size > GCODE_HEAD_BYTES:
                handle.seek(max(GCODE_HEAD_BYTES, size - GCODE_TAIL_BYTES))
                text += "\n" + handle.read().decode("latin-1")
    except OSError:
        return {}
    tail = text

    stats: dict = {}
    for pattern in _TIME_PATTERNS:
        match = pattern.search(tail)
        if not match:
            continue
        seconds = 0
        for value, unit in re.findall(r"(\d+)\s*([dhms])", match.group(1)):
            seconds += int(value) * _UNIT_SECONDS[unit]
        if seconds:
            stats["printTimeSeconds"] = seconds
        break
    for pattern in _GRAMS_PATTERNS:
        match = pattern.search(tail)
        if not match:
            continue
        # Multi-extruder values are comma-separated lists.
        total = 0.0
        for part in match.group(1).split(","):
            try:
                total += float(part.strip())
            except ValueError:
                continue
        if total:
            stats["filamentGrams"] = round(total, 2)
        break
    return stats


def sum_plate_stats(per_plate: dict | None) -> dict:
    """Total print time and filament across the plates the hook reported.

    Kept per plate rather than as a running total because the hook fires more
    than once for the same plate (a file export and a printer upload each get
    their own working copy), and adding those would report a project as taking
    twice as long as it does. Totals across plates are what the 3MF path
    reports from `slice_info`, so this matches it.
    """
    totals: dict = {}
    for stats in (per_plate or {}).values():
        if not isinstance(stats, dict):
            continue
        for key in ("printTimeSeconds", "filamentGrams"):
            value = stats.get(key)
            if isinstance(value, (int, float)):
                totals[key] = round(totals.get(key, 0) + value, 2)
    if "printTimeSeconds" in totals:
        totals["printTimeSeconds"] = int(totals["printTimeSeconds"])
    return totals


def strip_plugin_settings(raw: bytes) -> bytes:
    """Remove this plugin's own configuration from project_settings.config.

    OrcaSlicer keeps a plugin capability's config in the **print config**
    (`print_plugin_config_overrides`), so the push token — a long-lived write
    credential for the instance — is sitting in the checkpoint's settings in
    plaintext, and would ride along into the catalogue, where the file is
    downloadable by everyone who can see the model. Strip it before the bytes
    go anywhere.

    `plugins` and `slicing_pipeline_plugin` go with it: they name a plugin the
    next person to open the file does not have, and a hook must not arrive
    pre-enabled on someone else's machine.
    """
    keys = ("print_plugin_config_overrides", "plugins", "slicing_pipeline_plugin")
    try:
        config = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        config = None
    if not isinstance(config, dict):
        # Settings we cannot parse are not worth failing a sync over — but they
        # are not worth shipping a credential for either, so blank the override
        # textually and keep going.
        return re.sub(
            rb'"print_plugin_config_overrides"\s*:\s*"(?:[^"\\]|\\.)*"',
            b'"print_plugin_config_overrides": ""',
            raw,
        )
    config["print_plugin_config_overrides"] = ""
    config["plugins"] = []
    config["slicing_pipeline_plugin"] = []
    # The list of keys that differ from the system preset; leaving the plugin
    # keys in it would show the process preset as modified for no visible
    # reason on the machine that opens the file next.
    diffs = config.get("different_settings_to_system")
    if isinstance(diffs, list):
        config["different_settings_to_system"] = [
            ";".join(k for k in str(entry).split(";") if k and k not in keys)
            if isinstance(entry, str)
            else entry
            for entry in diffs
        ]
    # Orca writes this file tab-indented; matching it keeps a diff between a
    # synced file and a hand-saved one readable.
    return json.dumps(config, indent="\t", ensure_ascii=False).encode("utf-8")


# `<object id="N"` — the ids a `.model` part defines — and the component
# elements that point at them from another part.
_OBJECT_ID_RE = re.compile(rb"<object\s[^>]*?\bid=\"(\d+)\"")
_COMPONENT_RE = re.compile(rb"<component\b[^>]*?/?>")
_PATH_ATTR_RE = re.compile(rb'\bp:path="([^"]+)"')
_UUID_ATTR_RE = re.compile(rb'\bp:UUID="([^"]+)"')
# `id="N"` within an <object ...> opening tag we have already matched.
_OBJECTID_SELF_RE = re.compile(rb'\bid="(\d+)"')
_OBJECTID_ATTR_RE = re.compile(rb'\bobjectid="(\d+)"')
_BUILD_ITEM_RE = re.compile(rb"<item\b[^>]*?/?>")


def part_object_ids(data: bytes) -> list[bytes]:
    return _OBJECT_ID_RE.findall(data)


def component_map(model: bytes) -> dict:
    """`p:UUID` -> (part path, object id) for every component in a model.

    The production extension's UUIDs are the only identity that survives a
    save: OrcaSlicer renumbers objects, and stores an identical mesh once (so
    one part serves several objects and the duplicates' parts are written
    empty), but a component's `p:UUID` is byte-identical in the saved file and
    in the live checkpoint. That is how the saved file can say which of its
    parts and which object each of the checkpoint's components means.
    """
    found: dict = {}
    for match in _COMPONENT_RE.finditer(model):
        tag = match.group(0)
        uuid = _UUID_ATTR_RE.search(tag)
        path = _PATH_ATTR_RE.search(tag)
        objectid = _OBJECTID_ATTR_RE.search(tag)
        if uuid and path and objectid:
            found[uuid.group(1)] = (path.group(1).lstrip(b"/"), objectid.group(1))
    return found


def model_components(model: bytes) -> list:
    """(part path, object id, component UUID) for every component of this model
    that points into another part — i.e. every mesh the project needs."""
    needed = []
    for match in _COMPONENT_RE.finditer(model):
        tag = match.group(0)
        path = _PATH_ATTR_RE.search(tag)
        objectid = _OBJECTID_ATTR_RE.search(tag)
        if not path or not objectid:
            continue
        uuid = _UUID_ATTR_RE.search(tag)
        needed.append(
            (path.group(1).lstrip(b"/"), objectid.group(1), uuid.group(1) if uuid else None)
        )
    return needed


def object_elements(part: bytes) -> dict:
    """object id -> the whole `<object>` element, for every object in a part."""
    found: dict = {}
    for match in re.finditer(rb"<object\s[^>]*?>", part):
        tag = match.group(0)
        objectid = _OBJECTID_SELF_RE.search(tag)
        if not objectid:
            continue
        if tag.endswith(b"/>"):
            found[objectid.group(1)] = tag
            continue
        close = part.find(b"</object>", match.end())
        if close != -1:
            found[objectid.group(1)] = part[match.start() : close + len(b"</object>")]
    return found


def rewrite_object_id(element: bytes, new_id: bytes) -> bytes:
    """The same `<object>` element under a different id."""
    match = _OBJECT_ID_RE.search(element)
    if not match:
        return element
    return element[: match.start(1)] + new_id + element[match.end(1) :]


def objects_part(source: bytes, elements: list) -> bytes:
    """A mesh part holding exactly the given objects.

    The source part's other objects are dropped: they would keep the *source*
    file's numbering and collide with something. Non-object resources
    (materials, colour groups) are kept, and so are the source's namespaces —
    its own `<model>` element is reused rather than rebuilt.
    """
    body = b"\n  ".join(elements)
    stripped = re.sub(rb"<object\s[^>]*?>.*?</object>", b"", source, flags=re.S)
    stripped = re.sub(rb"<object\s[^>]*?/>", b"", stripped)
    marker = stripped.find(b"</resources>")
    if marker != -1:
        return stripped[:marker] + b"  " + body + b"\n " + stripped[marker:]
    opening = re.search(rb"<model\b[^>]*>", source)
    head = source[: opening.end()] if opening else b'<model unit="millimeter">'
    return head + b"\n <resources>\n  " + body + b"\n </resources>\n <build/>\n</model>"


def duplicate_object_ids(parts: dict, model: bytes) -> list:
    """Ids defined more than once across the package.

    three.js's 3MF loader keys objects by id in **one** namespace for the whole
    archive and ignores which part they came from (`buildObjects` in
    3MFLoader.js), so an id used by both a mesh part and the model's own
    wrapper objects means one silently shadows the other: the file opens in
    OrcaSlicer, slices in PrusaSlicer (which resolves by path), and renders an
    empty scene in the browser. Which is exactly what shipped once already.
    """
    seen: dict = {}
    for name, ids in list(parts.items()) + [("3D/3dmodel.model", part_object_ids(model))]:
        for oid in ids:
            seen.setdefault(oid, []).append(name)
    return [f"{oid.decode()} in {', '.join(where)}" for oid, where in seen.items() if len(where) > 1]


def unresolved_references(model: bytes, part_objects: dict) -> list:
    """Every component reference and build item pointing at an object the
    archive does not define — the check that would have caught the merge
    shipping a project nothing but OrcaSlicer could open."""
    known = {oid for ids in part_objects.values() for oid in ids} | set(part_object_ids(model))
    bad: list = []
    for path, objectid, _uuid in model_components(model):
        if objectid not in part_objects.get(path.decode("utf-8", "replace"), []):
            bad.append(f"component -> {path.decode('utf-8', 'replace')}#{objectid.decode()}")
    for match in _BUILD_ITEM_RE.finditer(model):
        objectid = _OBJECTID_ATTR_RE.search(match.group(0))
        if objectid and objectid.group(1) not in known:
            bad.append(f"build item -> #{objectid.group(1).decode()}")
    return bad


def _with_gcode_content_type(raw: bytes) -> bytes:
    """[Content_Types].xml must declare the G-code extension before a plate's
    G-code may live in the package. Orca's own writer already does; this only
    covers a base file that came from somewhere else."""
    if b'Extension="gcode"' in raw:
        return raw
    return raw.replace(
        b"</Types>",
        b' <Default Extension="gcode" ContentType="text/x.gcode"/>\n</Types>',
        1,
    )


def _checkpoint_loose_files(checkpoint_dir: str) -> dict[str, str]:
    """Package paths -> disk paths for the parts a checkpoint keeps outside its
    `.3mf`: meshes for objects edited or added in the slicer, and the project's
    auxiliary files."""
    loose: dict[str, str] = {}
    for tree in CHECKPOINT_TREES:
        base = os.path.join(checkpoint_dir, *tree.split("/"))
        for dirpath, _dirs, names in os.walk(base):
            for name in names:
                if name.startswith("."):
                    continue  # slicer scratch
                full = os.path.join(dirpath, name)
                relative = os.path.relpath(full, base).replace(os.sep, "/")
                loose[f"{tree}/{relative}"] = full
    return loose


def assemble_project(
    origin: str,
    checkpoint: dict,
    out_path: str,
    gcode_by_plate: dict | None = None,
    on_progress=None,
) -> dict:
    """Write a complete project `.3mf`: the project as the live checkpoint has
    it, with the meshes transplanted from the file it was opened from.

    **The checkpoint decides everything except geometry.** Its
    `3D/3dmodel.model` and `Metadata/*.config` are written verbatim, because
    they are one structure: `model_settings.config` keys per-object and
    per-part settings on the model's object ids, so touching one without the
    other loses exactly the settings a sync exists to carry. What the
    checkpoint does *not* have is meshes — only for objects edited or added in
    the slicer — so for every component the model references, the matching
    object is taken out of the saved file and written under the id the model
    asks for. The `p:UUID` on each component is what makes that lookup
    possible: object ids are renumbered on save and identical meshes are stored
    once (the duplicates' parts named but written empty), while the component
    UUIDs are byte-identical on both sides.

    Then: `project_settings.config` loses this plugin's own config (it holds
    the push token, see strip_plugin_settings); with `gcode_by_plate` each
    plate's G-code is embedded as `Metadata/plate_<n>.gcode` plus the `.md5`
    sidecar Bambu writes, which is the layout of an "export all plates sliced
    file" bundle; and nothing is returned until every component reference
    resolves and no object id is claimed twice.

    Streams part by part: this runs inside the slicer's own process, on a
    project that can be tens of MB.
    """
    if not origin or not os.path.isfile(origin):
        raise VaultError(
            "the file this project was opened from is gone, so there is nothing to "
            "merge the changes into — re-download it, or push an exported file instead"
        )
    if not zipfile.is_zipfile(origin):
        raise VaultError(f"{os.path.basename(origin)} is not a project file")
    project = checkpoint.get("project") or ""
    if not zipfile.is_zipfile(project):
        raise VaultError("OrcaSlicer's project checkpoint is not readable yet — try again in a moment")

    loose = _checkpoint_loose_files(checkpoint["dir"])
    written: set[str] = set()
    # Meshes lifted out of the saved file, and entries copied from it whole
    # (thumbnails, auxiliaries): reported so a sync can say where its bytes
    # came from.
    transplanted = 0
    from_origin = 0

    with zipfile.ZipFile(project) as live, zipfile.ZipFile(origin) as base, zipfile.ZipFile(
        out_path, "w", zipfile.ZIP_DEFLATED
    ) as out:
        # Object ids per mesh part as written, for the checks at the end.
        part_objects: dict = {}

        def copy(source: zipfile.ZipFile, name: str) -> None:
            with source.open(name) as reader, out.open(name, "w") as writer:
                shutil.copyfileobj(reader, writer, 1 << 20)
            written.add(name)

        def put(name: str, data: bytes) -> None:
            out.writestr(name, data)
            written.add(name)

        def put_part(name: str, data: bytes) -> None:
            part_objects[name] = part_object_ids(data)
            put(name, data)

        live_names = [n for n in live.namelist() if not n.endswith("/")]
        base_names = [n for n in base.namelist() if not n.endswith("/")]
        live_model = live.read(MODEL_PART)
        origin_model = base.read(MODEL_PART)

        # Content types first, the way every 3MF writer orders a package.
        for source, names in ((live, live_names), (base, base_names)):
            if CONTENT_TYPES_PART in names:
                raw = source.read(CONTENT_TYPES_PART)
                put(CONTENT_TYPES_PART, _with_gcode_content_type(raw) if gcode_by_plate else raw)
                break

        # Everything but the meshes comes from the checkpoint verbatim —
        # including `3D/3dmodel.model` itself. That is deliberate: the model's
        # object ids are what `model_settings.config` keys its per-object and
        # per-part settings on, so rewriting one without the other loses
        # exactly the settings this feature exists to carry. The checkpoint
        # decides the structure; the saved file only supplies geometry.
        for name in live_names:
            if name in written or name.startswith("3D/Objects/"):
                continue
            if name == PROJECT_SETTINGS_PART:
                put(name, strip_plugin_settings(live.read(name)))
            else:
                copy(live, name)

        for name, path in sorted(loose.items()):
            if name in written or name.startswith("3D/Objects/"):
                continue
            with open(path, "rb") as reader, out.open(name, "w") as writer:
                shutil.copyfileobj(reader, writer, 1 << 20)
            written.add(name)

        # The origin supplies what the checkpoint has no copy of: thumbnails,
        # auxiliaries, and anything a future version of the format adds.
        for index, name in enumerate(base_names):
            if name in written or name.startswith("3D/Objects/"):
                continue
            copy(base, name)
            from_origin += 1
            if on_progress and index % 8 == 0:
                on_progress(min(0.6, index / max(1, len(base_names))))

        # --- the meshes -----------------------------------------------------
        #
        # One part per component the model asks for, holding the object under
        # the id it asks for. Which source that object comes from is the whole
        # question: the checkpoint has a part only for meshes edited or added
        # in the slicer, and the saved file numbers its objects differently and
        # stores an identical mesh once (naming the duplicates' parts but
        # leaving them empty). The component `p:UUID` — the one identity that
        # survives a save — says which of the saved file's parts and objects
        # each component means.
        origin_by_uuid = component_map(origin_model)
        base_parts = {n for n in base_names if n.startswith("3D/Objects/")}
        problems: list = []
        plan: dict = {}
        for path, object_id, uuid in model_components(live_model):
            name = path.decode("utf-8", "replace")
            source = None
            if name in loose:
                source = ("loose", name, object_id)
            elif name in set(live_names):
                source = ("live", name, object_id)
            elif uuid in origin_by_uuid:
                mapped_path, mapped_id = origin_by_uuid[uuid]
                mapped_name = mapped_path.decode("utf-8", "replace")
                if mapped_name in base_parts:
                    source = ("base", mapped_name, mapped_id)
            if source is None and name in base_parts:
                source = ("base", name, object_id)
            if source is None:
                problems.append(f"{name}#{object_id.decode()} is in neither file")
                continue
            plan.setdefault(name, []).append((source, object_id))

        for index, (name, entries) in enumerate(sorted(plan.items())):
            elements = []
            envelope = b""
            for (kind, source_name, source_id), object_id in entries:
                if kind == "loose":
                    with open(loose[source_name], "rb") as reader:
                        data = reader.read()
                else:
                    data = (live if kind == "live" else base).read(source_name)
                envelope = data
                objects = object_elements(data)
                element = objects.get(source_id)
                if element is None and len(objects) == 1:
                    # A part with one object can only mean that one, whatever
                    # it happens to call it.
                    element = next(iter(objects.values()))
                if element is None:
                    problems.append(
                        f"{source_name} holds {len(objects)} object(s), none of them "
                        f"{source_id.decode()}"
                    )
                    continue
                if kind == "base":
                    transplanted += 1
                elements.append(rewrite_object_id(element, object_id))
            if elements:
                put_part(name, objects_part(envelope, elements))
            if on_progress:
                on_progress(min(0.95, 0.6 + 0.35 * (index + 1) / max(1, len(plan))))

        for plate, path in sorted((gcode_by_plate or {}).items()):
            name = f"Metadata/plate_{plate}.gcode"
            # A file checksum for the printer, not a security property: this is
            # the digest Bambu's own bundle carries, uppercase and unterminated.
            digest = hashlib.md5()  # noqa: S324
            with open(path, "rb") as reader, out.open(name, "w") as writer:
                for block in iter(lambda: reader.read(1 << 20), b""):
                    digest.update(block)
                    writer.write(block)
            written.add(name)
            put(f"{name}.md5", digest.hexdigest().upper().encode("ascii"))

        # Nothing ships that a reader cannot resolve. Both checks exist because
        # a merge that satisfied neither was pushed to a real catalogue: the
        # file opened in OrcaSlicer, refused to load in PrusaSlicer, and
        # rendered an empty scene in the browser.
        problems += unresolved_references(live_model, part_objects)
        problems += [f"object id {clash}" for clash in duplicate_object_ids(part_objects, live_model)]
        if problems:
            raise VaultError(
                f"the merged project would not load: {len(problems)} problem(s), first "
                f"{problems[0]} — push an exported file instead"
            )

    size = os.path.getsize(out_path)
    if size > MAX_PUSH_BYTES:
        os.remove(out_path)
        raise VaultError(
            f"the assembled project is {size // (1 << 20)} MB, past the "
            f"{MAX_PUSH_BYTES // (1 << 20)} MB the instance accepts"
            + (" — turn off include_gcode" if gcode_by_plate else "")
        )

    if on_progress:
        on_progress(1.0)
    return {
        "path": out_path,
        "bytes": size,
        "parts": len(written),
        "meshesFromOrigin": transplanted,
        "copiedFromOrigin": from_origin,
        "gcodePlates": sorted((gcode_by_plate or {}).keys()),
    }


def push_entry(entry: dict, model_id: str, on_progress=None, client: VaultClient | None = None) -> str:
    """Uploads one queued (or just-sliced) artifact. Returns a sentence for the
    user; raises VaultError with one on failure.

    `client` is passed by the CLI, which is configured from flags that may
    never have been saved; everything inside the slicer falls through to the
    stored settings.
    """
    client = client or STATE.client()
    answer = client.push(
        model_id,
        entry["path"],
        entry["filename"],
        entry.get("meta"),
        on_progress=on_progress,
        replaces=entry.get("replaces"),
        batch=entry.get("batch"),
        batch_final=bool(entry.get("batchFinal")),
    )
    verb = "Replaced" if answer.get("status") == "replaced" else "Added"
    entry = {**entry, "filename": answer.get("filename") or entry["filename"]}
    minutes = answer.get("printTimeSeconds")
    detail = f" ({int(minutes) // 60} min)" if isinstance(minutes, (int, float)) else ""
    return f"{verb} {entry['filename']}{detail}"


def sync_push(
    entry: dict,
    model_id: str,
    client: VaultClient | None = None,
    on_progress=None,
) -> str:
    """Assemble the open project from its checkpoint and push it as a new
    revision of the model's *own* `.3mf`.

    This is the push the feature exists for: the file in the catalogue ends up
    carrying the settings, filaments, colours and plate layout the user just
    worked out, under its own name, as one version. The G-code is in there too
    when `include_gcode` is on, and nowhere at all when it is not.
    """
    checkpoint = checkpoint_at(entry.get("checkpoint", "")) or {}
    origin = entry.get("origin") or checkpoint.get("origin")
    if not checkpoint:
        raise VaultError("OrcaSlicer's project checkpoint is gone — reopen the project and slice again")

    kept = {}
    for plate, path in (entry.get("gcode") or {}).items():
        if os.path.isfile(path):
            try:
                kept[int(plate)] = path
            except (TypeError, ValueError):
                continue

    out = os.path.join(STATE.sync_dir(), f"{uuid.uuid4().hex}.3mf")
    try:
        # Assembly is the first third of the progress bar, the upload the rest:
        # the bar is the only sign of life during either.
        result = assemble_project(
            origin,
            checkpoint,
            out,
            gcode_by_plate=kept or None,
            on_progress=(lambda f: on_progress(f * 0.3)) if on_progress else None,
        )
        log(
            f"assembled {result['bytes'] // (1 << 20)} MB from the checkpoint "
            f"({result['meshesFromOrigin']} mesh(es) transplanted from {os.path.basename(origin or '?')}"
            + (f", G-code for plate(s) {result['gcodePlates']}" if kept else "")
            + ")"
        )
        base_name = entry.get("filename") or os.path.basename(origin or "project.3mf")
        return push_entry(
            {
                **entry,
                "path": out,
                "filename": push_filename(out, None, base_name, None),
                # The footer numbers ride along as a fallback: the checkpoint's
                # own slice_info is only rewritten when the *model* changes, so
                # a sync straight after a re-slice can carry the previous
                # slice's predictions, or none at all.
                "meta": {
                    **(entry.get("meta") or {}),
                    **sum_plate_stats(entry.get("plateStats")),
                }
                or None,
            },
            model_id,
            on_progress=(lambda f: on_progress(0.3 + f * 0.7)) if on_progress else None,
            client=client,
        )
    finally:
        try:
            os.remove(out)
        except OSError:
            pass


def sync_summary(entry: dict, include_project: bool = True) -> str:
    """One line describing what a queued sync would change, for the window.

    `include_project` is off where the card already says that the settings and
    the layout are going — then this is only what the *slice* adds.
    """
    plates = [n for n in entry.get("plates", []) if n]
    bits = ["settings, filaments and layout"] if include_project else []
    if plates:
        bits.append(f"{len(plates)} sliced plate" + ("" if len(plates) == 1 else "s"))
    if entry.get("gcode"):
        count = len(entry["gcode"])
        bits.append(f"G-code for {count} plate" + ("" if count == 1 else "s") + " embedded")
    seconds = sum_plate_stats(entry.get("plateStats")).get("printTimeSeconds")
    if seconds:
        bits.append(f"{int(seconds) // 3600} h {int(seconds) % 3600 // 60} min")
    return " \u00b7 ".join(bits) if bits else "nothing new"


def is_temp_name(name: str) -> bool:
    """Whether a name is a slicer scratch file rather than something a person
    chose. On a Bambu printer the hook is handed
    `<backup>/Metadata/.<pid>.<counter>.gcode` as *both* the artifact and the
    "output name" (BackgroundSlicingProcess.cpp passes m_temp_output_path
    twice), so ".74890.3.gcode" is what an unguarded implementation stores.
    Note the counter is a global allocation counter, not the plate index —
    it cannot be used to number plates."""
    base = os.path.basename(name or "")
    return not base or base.startswith(".")


def push_filename(
    gcode_path: str,
    output_name: str | None,
    base_name: str | None = None,
    plate: int | None = None,
) -> str:
    """What the revision is stored as.

    Preference order: the name the user chose in the export dialog, then the
    name of the catalogue file this project came from (plus a plate number,
    since one export is one plate), and only then whatever the temp file is
    called. The extension follows the *bytes*, not the name, because a
    Bambu-style setup calls its export .gcode.3mf while what we hold here is
    plain G-code.
    """
    suffix = os.path.splitext(gcode_path)[1].lower()
    chosen = os.path.basename((output_name or "").strip())
    if is_temp_name(chosen) and base_name:
        stem = os.path.splitext(os.path.basename(base_name))[0]
        # Strip an artifact suffix the stem may still carry ("Part.gcode.3mf").
        while True:
            head, ext = os.path.splitext(stem)
            if ext.lower() in ALLOWED_SUFFIXES and head:
                stem = head
            else:
                break
        plate_part = f"_plate_{plate}" if plate else ""
        return f"{stem}{plate_part}{suffix}"

    name = chosen or os.path.basename(gcode_path)
    if not suffix or name.lower().endswith(suffix):
        return name
    # "Benchy.gcode.3mf" is a *double* artifact suffix, so one splitext leaves
    # "Benchy.gcode" and appending would produce "Benchy.gcode.gcode". Strip
    # every artifact suffix off the stem before re-attaching the real one.
    while True:
        stem, ext = os.path.splitext(name)
        if ext.lower() in ALLOWED_SUFFIXES and stem:
            name = stem
        else:
            break
    return f"{name}{suffix}"


# --- Capability 1: the slicing hook ----------------------------------------


class PrintVaultSlicePush(orca.slicing.SlicingPipelineCapabilityBase if orca else object):
    """Captures the slice at Step.psGCodePostProcess.

    What it queues is a **sync**, not the G-code: the project as OrcaSlicer's
    own checkpoint has it — process settings, filament and colour assignment,
    plate layout, per-object overrides — merged onto the file the project was
    opened from, and pushed as a new revision of the model's own `.3mf`. The
    plate's G-code is kept only when `include_gcode` asks for it, and then it
    travels *inside* that `.3mf`. Where there is no checkpoint to merge (auto
    backup switched off, or the origin file gone) it falls back to the plate's
    G-code on its own, stored next to the model's file.

    Cannot show UI (see the module docstring), so it either pushes silently —
    when the model is unambiguous and the user has already said yes to it — or
    queues for the sync window. It never raises: a failed push must not break
    a print.
    """

    def __init__(self):
        super().__init__()
        # (filename, size) of the last artifact handled, with a timestamp. The
        # post-process step can fire twice for one slice (file export and
        # upload each get their own working copy), and each firing would
        # otherwise become its own revision.
        self._last: tuple[str, int, float] | None = None
        # (origin, checkpoint mtime) -> when it was last pushed unattended, so
        # "Slice all" is one push. Eighteen firings describe the same project
        # state: the checkpoint is not rewritten by slicing, so re-pushing it
        # per plate would write eighteen identical versions of one file. An
        # edit *between* plates moves the mtime and is pushed as the new state
        # it is.
        self._synced: dict[tuple[str, float], float] = {}

    def get_name(self):
        return "Push sliced file to Print Vault"

    def get_default_config(self):
        return dict(DEFAULTS)

    def has_config_ui(self):
        return True

    def get_config_ui(self):
        return CONFIG_HTML

    def on_load(self):
        STATE.config_owner = self
        STATE.queue_trim()
        # The credential may be sitting in the print profile, put there by an
        # older version of this plugin.
        STATE.migrate_token_out_of_config()
        # Debris from a push that failed halfway through assembling.
        STATE.sync_clear()

    def on_unload(self):
        if STATE.config_owner is self:
            STATE.config_owner = None

    def execute(self, ctx):
        try:
            return self._execute(ctx)
        except Exception as exc:  # noqa: BLE001 - a slice must survive anything
            log(f"skipped: {exc}")
            return orca.ExecutionResult.success(f"Print Vault: skipped ({exc})")

    def _execute(self, ctx):
        # Every geometry step is a no-op; only the export seam carries output.
        if ctx.step != orca.slicing.Step.psGCodePostProcess:
            return orca.ExecutionResult.success()
        if not ctx.gcode_path:
            return orca.ExecutionResult.success()

        settings = STATE.settings()
        if settings.get("mode") == "off":
            return orca.ExecutionResult.success()
        # Cheap, and a no-op unless a token is sitting in the print profile —
        # which is where the Config tab puts one, because that is the only
        # editor the host gives a capability.
        STATE.migrate_token_out_of_config()

        client = STATE.client()
        if not client.configured():
            return orca.ExecutionResult.success(
                "Print Vault: not set up — add the instance URL and a push token in the plugin's Config tab"
            )

        size = os.path.getsize(ctx.gcode_path)
        # Logged unconditionally: when someone asks "why did nothing happen?",
        # the answer is one of "the profile does not list this plugin" or "you
        # sliced without exporting", and the absence of this line proves which.
        log(
            f"handling {os.path.basename(ctx.gcode_path)} "
            f"({size // (1 << 20)} MB, host={getattr(ctx, 'host', '') or '?'})"
        )
        now = time.time()
        # Keyed on the artifact itself, not on the name derived below: the same
        # export can reach us twice (a file export and an upload each get their
        # own working copy) and each firing would otherwise become a revision.
        signature = os.path.basename(ctx.gcode_path)
        if self._last and self._last[0] == signature and self._last[1] == size and now - self._last[2] < 60:
            return orca.ExecutionResult.success("Print Vault: already handled this export")
        self._last = (signature, size, now)

        # Where the *project* is (see "The project checkpoint" above). The
        # artifact the hook was handed lives inside it, so finding it here
        # costs nothing — no scanning, no guessing.
        checkpoint = project_checkpoint(ctx.gcode_path)
        identity = checkpoint_identity(collect_identity(), checkpoint)
        try:
            candidates = client.resolve(
                identity["hashes"], identity["filenames"], identity["designId"]
            )
        except VaultError as exc:
            log(str(exc))
            candidates = []

        if not candidates:
            # Nothing about the file identifies it — re-saved project, a "(7)"
            # the slicer appended, a model that was never downloaded from here.
            # Where the user sent this project last time is a better answer
            # than giving up.
            fallback = remembered_target(identity)
            if fallback:
                candidates = [fallback]
                log(f"no match; using the remembered target {fallback.get('modelTitle')}")

        plate = current_plate()
        origin = (checkpoint or {}).get("origin")
        # Syncing needs both halves: the checkpoint for what changed, and the
        # file the project was loaded from for the meshes it does not carry.
        can_sync = bool(
            checkpoint and checkpoint.get("ready") and origin and os.path.isfile(origin)
        )
        # Named after the catalogue file this project came from, never after
        # the slicer's scratch file.
        base_name = (
            (candidates[0].get("filename") if candidates else None)
            or (os.path.basename(origin) if origin else None)
            or (identity["filenames"][0] if identity["filenames"] else None)
        )

        model_id = candidates[0]["modelId"] if candidates else None
        always = bool(settings.get("always", {}).get(model_id)) if model_id else False
        mode = settings.get("mode", "ask")
        # Only an exact file match — or the user's own earlier decision about
        # this very project — is ever pushed to unattended: a revision on the
        # wrong model is the one mistake with no cheap undo.
        confident = len(candidates) == 1 and candidates[0].get("via") in ("hash", "remembered")
        common = {
            "host": getattr(ctx, "host", "") or "",
            "meta": collect_meta(ctx),
            "candidates": candidates,
            "identity": identity,
            "plate": plate,
        }
        queue_cap = int(settings.get("max_queue_mb", 1024)) * (1 << 20)

        if can_sync:
            entry = {
                **common,
                "kind": "sync",
                # The name of the catalogue file this revises. What gets pushed
                # is the project, so there is no plate number in it: one sync
                # covers every plate the checkpoint holds.
                "filename": base_name or os.path.basename(origin),
                "checkpoint": checkpoint["dir"],
                "origin": origin,
                "plates": [plate] if plate else [],
                # The estimate the checkpoint's slice_info may not have caught
                # up to yet, per plate so re-firings don't double it — see
                # sum_plate_stats and sync_push.
                "plateStats": {str(plate or "?"): parse_gcode_stats(ctx.gcode_path)},
            }
            stored = STATE.queue_upsert_sync(entry)
            if settings.get("include_gcode") and plate:
                kept = STATE.queue_keep_gcode(stored["id"], plate, ctx.gcode_path, queue_cap)
                if kept:
                    stored = STATE.queue_put(
                        {**stored, "gcode": {**stored.get("gcode", {}), str(plate): kept}}
                    )

            # Embedding the G-code makes every plate's firing materially
            # different — and there is no seam that says "that was the last
            # plate" — so an unattended push would either miss plates or write
            # a version per plate. It waits for the window instead, where one
            # push carries every plate that was sliced.
            unattended = confident and (mode == "auto" or always)
            if unattended and settings.get("include_gcode"):
                log("include_gcode is on, so the sync waits for the window (one push, all plates)")
                unattended = False

            state_key = (origin, checkpoint["mtime"])
            pushed_at = self._synced.get(state_key)
            if unattended and pushed_at and now - pushed_at < 900:
                STATE.queue_remove(stored["id"])
                return orca.ExecutionResult.success(
                    "Print Vault: this project state is already in the catalogue"
                )

            if unattended:
                try:
                    message = sync_push(
                        {**stored, "replaces": file_id_for(candidates, model_id)},
                        model_id,
                        client=client,
                    )
                    remember_target(identity, candidates[0])
                    STATE.queue_remove(stored["id"])
                    # Bounded: one entry per project state, and a slicer
                    # session does not produce many.
                    if len(self._synced) > 32:
                        self._synced.clear()
                    self._synced[state_key] = time.time()
                    log(message)
                    return orca.ExecutionResult.success(f"Print Vault: {message}")
                except VaultError as exc:
                    log(f"sync failed, leaving it queued: {exc}")

            if settings.get("prompt_after_slice"):
                STATE.notify_queued()
            title = candidates[0]["modelTitle"] if candidates else "an unmatched model"
            plates = ", ".join(str(n) for n in stored.get("plates", []) if n)
            return orca.ExecutionResult.success(
                f"Print Vault: {stored['filename']} for {title} is ready to sync"
                + (f" (plate {plates})" if plates else "")
                + ' — run "Sync with Print Vault"'
            )

        # No checkpoint, so there is no project to merge into — and a plate's
        # raw G-code on its own is not worth storing: it would sit next to the
        # model's file as a row no preview, deep link or estimate can use. Say
        # why and stop. Expected when Preferences -> Auto backup is off, or
        # when the file the project was opened from has been moved or deleted.
        if checkpoint and not checkpoint.get("ready"):
            reason = (
                "OrcaSlicer has not written a project snapshot yet — it writes one a few "
                "seconds after the first change to the project"
            )
        elif checkpoint:
            reason = "the file this project was opened from is gone"
        else:
            reason = "OrcaSlicer has no project checkpoint (Preferences -> Auto backup)"
        log(f"nothing to sync: {reason}")
        return orca.ExecutionResult.success(f"Print Vault: nothing to sync — {reason}")

# --- Capability 2: the sync window ---------------------------------------


class PrintVaultSync(orca.script.ScriptPluginCapabilityBase if orca else object):
    """The window where the actual decision is made: update the catalogue, or
    keep this slice local.

    A script capability because that is the only place a plugin may open UI —
    it is run from the Plugins dialog (or the Actions Speed Dial, which puts it
    one click from the plate). Everything slow happens on a worker thread and
    reports back through `win.post()`; `on_message` itself runs on the UI
    thread and must stay quick.
    """

    def __init__(self):
        super().__init__()
        self.win = None
        # Candidates for whatever project is open right now, resolved once per
        # window rather than per listed file: every export in the list came
        # from the same plate.
        self._project_candidates: list[dict] = []
        self._project_identity: dict = {}

    def get_name(self):
        # This is the name the user sees in the Plugins dialog and — because a
        # script capability is also an entry in the Actions Speed Dial, where
        # it can be pinned as a favourite tile — the closest thing the host API
        # allows to a "Sync with Print Vault" button on the plater.
        return "Sync with Print Vault"

    def has_config_ui(self):
        # Every capability gets a Config tab whether it wants one or not, and an
        # empty "{}" JSON editor next to the capability that *does* hold the
        # settings is an invitation to configure the wrong one.
        return True

    def get_config_ui(self):
        return POINTER_HTML

    def on_load(self):
        STATE.window = self
        STATE.sync_clear()

    def on_unload(self):
        if STATE.window is self:
            STATE.window = None

    def execute(self):
        self.show()
        return orca.ExecutionResult.success()

    def show(self) -> None:
        """Open the window, or refresh it if it is already up.

        Called both by the Run action and — after a slice — by the hook, which
        may not touch the UI itself. Refreshing rather than reopening is the
        whole point: a "Slice all" adds plates to the list you are already
        looking at instead of stacking a dialog per plate.
        """
        if self.win is not None and self.win.is_open():
            self._send_state()
            return
        self.win = orca.host.ui.create_window(
            REVIEW_HTML,
            title="Print Vault",
            width=760,
            height=620,
            on_message=self.on_message,
            on_close=self._forget,
        )
        # Syncing the open project is the point of this window, so it works out
        # which model that is without being asked. One small POST, once per
        # window; "Match the open plate" re-runs it after switching projects.
        if not self._project_candidates:
            self._run(self._resolve_project)

    def _forget(self):
        self.win = None

    # --- page -> plugin ---

    def on_message(self, msg):
        try:
            command = (msg or {}).get("command")
            if command == "state":
                self._send_state()
            elif command == "setup":
                self._run(self._setup, msg.get("url", ""), msg.get("token", ""))
            elif command == "settings":
                STATE.save_settings(
                    {
                        "mode": msg.get("mode", "ask"),
                        "prompt_after_slice": bool(msg.get("promptAfterSlice")),
                        "include_gcode": bool(msg.get("includeGcode")),
                    }
                )
                self._send_state()
            elif command == "discard":
                STATE.queue_remove(msg.get("id", ""))
                self._send_state()
            elif command == "sync":
                self._run(
                    self._sync,
                    msg.get("id", ""),
                    msg.get("modelId", ""),
                    bool(msg.get("always")),
                )
            elif command == "project":
                self._run(self._resolve_project)
            elif command == "search":
                self._run(self._search, msg.get("query", ""))
            elif command == "pushfile":
                self._run(
                    self._push_file,
                    msg.get("path", ""),
                    msg.get("modelId", ""),
                    bool(msg.get("always")),
                )
        except Exception as exc:  # noqa: BLE001
            self._post({"command": "result", "ok": False, "message": str(exc)})

    # --- helpers ---

    def _post(self, payload: dict) -> None:
        if self.win is not None and self.win.is_open():
            self.win.post(payload)

    def _run(self, fn, *args) -> None:
        """on_message runs on the UI thread; network calls do not belong there."""
        threading.Thread(target=fn, args=args, daemon=True).start()

    def _send_state(self) -> None:
        settings = STATE.settings()
        client = STATE.client()
        project = self._project_info()
        # A sync the hook queued for the project on the plate is the *same
        # push* as the button on that card — one project, one file, one
        # version. Listing it a second time below asked the same question
        # twice and read as two different things to do. Anything left in the
        # list belongs to another project (or one that has since been closed),
        # which genuinely is a separate target.
        pending = [
            entry
            for entry in STATE.queue_list()
            if not (
                entry.get("kind") == "sync"
                and project.get("origin")
                and entry.get("origin") == project.get("origin")
            )
        ]
        self._post(
            {
                "command": "state",
                "data": {
                    "configured": client.configured(),
                    "url": settings.get("url", ""),
                    "tokenSet": bool(settings.get("token")),
                    "mode": settings.get("mode", "ask"),
                    "promptAfterSlice": bool(settings.get("prompt_after_slice")),
                    "always": settings.get("always", {}),
                    # Files already on disk that the hook never saw — the path
                    # that works without the process preset listing us.
                    "exports": recent_exports(settings.get("export_dirs", [])),
                    "exportDirs": settings.get("export_dirs") or default_export_dirs(),
                    "projectCandidates": self._project_candidates,
                    "includeGcode": bool(settings.get("include_gcode")),
                    # What the project on the plate is, and how fresh
                    # OrcaSlicer's checkpoint of it is — the sync is only ever
                    # as current as that.
                    "project": project,
                    "pending": [
                        {
                            "id": entry.get("id"),
                            "filename": entry.get("filename"),
                            "kind": entry.get("kind", "sync"),
                            "sizeMb": round(entry.get("size", 0) / (1 << 20), 1),
                            "summary": sync_summary(entry) if entry.get("kind") == "sync" else "",
                            "queuedAt": entry.get("queuedAt"),
                            "candidates": entry.get("candidates", []),
                            "meta": entry.get("meta", {}),
                        }
                        for entry in pending
                    ],
                },
            }
        )

    def _project_info(self) -> dict:
        """What the window says about the project on the plate: the file it was
        opened from, how fresh OrcaSlicer's checkpoint of it is, and how many
        plates that checkpoint carries predictions for."""
        checkpoint = project_checkpoint()
        if not checkpoint:
            return {"hasCheckpoint": False}
        origin = checkpoint.get("origin")
        # A slice the hook captured for this project: what it adds to the push
        # is the G-code (when that is switched on) and the estimate the
        # checkpoint's own predictions may not have caught up with.
        ready = bool(checkpoint.get("ready"))
        queued = next(
            (
                entry
                for entry in STATE.queue_list()
                if entry.get("kind") == "sync" and origin and entry.get("origin") == origin
            ),
            None,
        )
        return {
            "hasCheckpoint": True,
            # The folder is there but the snapshot is not: nothing to sync
            # until OrcaSlicer writes one, which the first change triggers.
            "pendingSnapshot": not ready,
            "origin": origin,
            "originName": os.path.basename(origin) if origin else None,
            "queuedId": queued.get("id") if queued else None,
            "queuedSummary": sync_summary(queued, include_project=False) if queued else None,
            # No origin, or a deleted one, means no meshes to merge the changes
            # into — the one case a sync cannot cover.
            "originMissing": not (origin and os.path.isfile(origin)),
            "ageSeconds": max(0, int(time.time() - checkpoint["mtime"])),
            "plates": checkpoint_plates(checkpoint),
            "dirty": self._project_dirty(),
        }

    @staticmethod
    def _project_dirty() -> bool:
        dirty = False
        for probe in ("is_project_dirty", "is_presets_dirty"):
            try:
                dirty = dirty or bool(getattr(orca.host, probe)())
            except Exception:
                pass
        return dirty

    # One `backup_interval` (Preferences → Auto backup, 10 s by default) plus
    # slack. A user who raised that interval gets the checkpoint on disk
    # instead of a longer wait, which is what they would have got anyway.
    CHECKPOINT_WAIT = 12.0

    def _await_checkpoint(self, checkpoint_dir: str, timeout: float = CHECKPOINT_WAIT) -> dict:
        """Give OrcaSlicer's auto-backup timer a chance to catch up.

        The checkpoint is rewritten on a timer (Preferences -> Auto backup,
        every 10 s by default) while the project is dirty, so a sync started
        seconds after moving an object would otherwise push the layout from
        before the move. Waited on only when the project *is* dirty and the
        checkpoint is already older than one interval: one written a moment ago
        is the answer, not something to wait past. Runs on a worker thread, so
        sleeping here blocks nothing.
        """
        checkpoint = checkpoint_at(checkpoint_dir) or {}
        if (
            not checkpoint
            or not self._project_dirty()
            or time.time() - checkpoint["mtime"] < self.CHECKPOINT_WAIT
        ):
            return checkpoint
        self._post(
            {
                "command": "result",
                "ok": True,
                "message": "Waiting for OrcaSlicer\u2019s next project checkpoint\u2026",
            }
        )
        was = checkpoint["mtime"]
        deadline = time.time() + timeout
        while time.time() < deadline:
            time.sleep(0.5)
            fresh = checkpoint_at(checkpoint_dir)
            if fresh and fresh["mtime"] > was:
                return fresh
        log("the checkpoint did not advance; syncing the one on disk")
        return checkpoint

    @staticmethod
    def _not_ready_message(checkpoint: dict | None) -> str:
        if checkpoint and not checkpoint.get("ready"):
            return (
                "OrcaSlicer has not written a project snapshot yet \u2014 change something on "
                "the plate (or wait a few seconds) and try again."
            )
        return (
            "No project checkpoint yet \u2014 OrcaSlicer writes one every few seconds while a "
            "project is open (Preferences \u2192 Auto backup)."
        )

    def _sync(self, entry_id: str, model_id: str, always: bool) -> None:
        """Update the model's own `.3mf` from the live project.

        Called for a queued slice (`entry_id` set) and for the project on the
        plate with nothing queued at all — settings and layout are worth
        pushing whether or not the project has been sliced since they changed.
        """
        if not model_id:
            self._post({"command": "result", "ok": False, "message": "Pick a model first"})
            return
        entry = STATE.queue_get(entry_id) if entry_id else None
        if entry_id and not entry:
            self._post({"command": "result", "ok": False, "message": "That slice is no longer queued"})
            return
        if entry is None:
            checkpoint = project_checkpoint()
            if not checkpoint or not checkpoint.get("ready") or not checkpoint.get("origin"):
                self._post(
                    {
                        "command": "result",
                        "ok": False,
                        "message": self._not_ready_message(checkpoint),
                    }
                )
                return
            candidates = self._project_candidates
            named = next(
                (
                    c.get("filename")
                    for c in candidates
                    if c.get("modelId") == model_id and c.get("filename")
                ),
                None,
            )
            entry = {
                "kind": "sync",
                "checkpoint": checkpoint["dir"],
                "origin": checkpoint["origin"],
                "filename": named or os.path.basename(checkpoint["origin"]),
                "plates": checkpoint_plates(checkpoint),
                "meta": collect_meta_host(),
                "candidates": candidates,
                "identity": self._project_identity or collect_identity(),
            }

        bar = entry_id or "project"
        checkpoint = self._await_checkpoint(entry.get("checkpoint", ""))
        try:
            message = sync_push(
                {
                    **entry,
                    "checkpoint": checkpoint.get("dir", entry.get("checkpoint")),
                    "replaces": file_id_for(entry.get("candidates", []), model_id),
                },
                model_id,
                on_progress=lambda fraction: self._post(
                    {"command": "progress", "id": bar, "fraction": fraction}
                ),
            )
        except VaultError as exc:
            self._post({"command": "result", "ok": False, "message": str(exc)})
            self._send_state()
            return

        chosen = next(
            (c for c in entry.get("candidates", []) if c.get("modelId") == model_id),
            {"modelId": model_id, "modelTitle": "this model"},
        )
        remember_target(entry.get("identity", {}), chosen)
        if always:
            remembered = dict(STATE.settings().get("always", {}))
            remembered[model_id] = True
            STATE.save_settings({"always": remembered})
        if entry_id:
            STATE.queue_remove(entry_id)
        self._post({"command": "result", "ok": True, "message": message})
        self._send_state()

    def _setup(self, url: str, token: str) -> None:
        # Verified before it is stored, so a typo is reported here rather than
        # silently, after a 40-minute slice.
        client = VaultClient(url, token)
        try:
            answer = client.ping()
        except VaultError as exc:
            self._post({"command": "result", "ok": False, "message": str(exc)})
            return
        STATE.save_settings({"url": client.url, "token": client.token})
        who = answer.get("user") or "this instance"
        self._post({"command": "result", "ok": True, "message": f"Connected as {who}"})
        self._send_state()

    def _resolve_project(self) -> None:
        """Which model is open on the plate right now — the answer the exports
        list needs, and the one the hook would have worked out itself."""
        # The checkpoint's origin.txt names the `.3mf` the project was opened
        # from, which is the file the catalogue actually served — object
        # `input_file` paths can be the STLs a project was assembled out of.
        identity = checkpoint_identity(collect_identity(), project_checkpoint())
        self._project_identity = identity
        try:
            self._project_candidates = STATE.client().resolve(
                identity["hashes"], identity["filenames"], identity["designId"]
            )
        except VaultError as exc:
            self._post({"command": "result", "ok": False, "message": str(exc)})
            return
        remembered = remembered_target(identity)
        if not self._project_candidates and remembered:
            self._project_candidates = [remembered]
        if not self._project_candidates:
            self._post(
                {
                    "command": "result",
                    "ok": False,
                    "message": "Nothing on the plate matches a model — search for one by name.",
                }
            )
        self._send_state()

    def _search(self, query: str) -> None:
        """Find a model by title.

        The last resort, and the one that makes the feature usable on a
        catalogue that predates content hashing: a file the instance has no
        hash for, opened under a name macOS made unique ("fuselage(7).3mf"),
        matches nothing at all. Whatever the user picks here is remembered
        against this project, so it is asked once.
        """
        if len(query.strip()) < 2:
            return
        try:
            found = STATE.client().resolve([], [], None, query=query.strip())
        except VaultError as exc:
            self._post({"command": "result", "ok": False, "message": str(exc)})
            return
        if not self._project_identity:
            self._project_identity = collect_identity()
        # Keep any real matches ahead of what the user typed.
        existing = {c["modelId"] for c in self._project_candidates}
        self._project_candidates += [c for c in found if c["modelId"] not in existing]
        if not found:
            self._post({"command": "result", "ok": False, "message": f"No model matches “{query}”"})
        self._send_state()

    def _push_file(self, path: str, model_id: str, always: bool) -> None:
        """Push a file the user picked out of an export folder."""
        settings = STATE.settings()
        allowed = settings.get("export_dirs") or default_export_dirs()
        real = os.path.realpath(path)
        # The page can only offer paths we listed, but it is a web page: check
        # again that this is a real file inside a folder we scan.
        inside = any(
            os.path.commonpath([real, os.path.realpath(d)]) == os.path.realpath(d)
            for d in allowed
            if os.path.isdir(d)
        )
        if not (inside and os.path.isfile(real) and real.lower().endswith(PUSH_SUFFIXES)):
            self._post({"command": "result", "ok": False, "message": "That file is not in a watched export folder"})
            return
        if not model_id:
            self._post({"command": "result", "ok": False, "message": "Pick a model first"})
            return

        entry = {
            "path": real,
            "filename": os.path.basename(real),
            "meta": collect_meta_host(),
            "replaces": file_id_for(self._project_candidates, model_id),
        }
        try:
            message = push_entry(
                entry,
                model_id,
                on_progress=lambda fraction: self._post(
                    {"command": "progress", "id": real, "fraction": fraction}
                ),
            )
        except VaultError as exc:
            self._post({"command": "result", "ok": False, "message": str(exc)})
            return
        chosen = next(
            (c for c in self._project_candidates if c.get("modelId") == model_id),
            {"modelId": model_id, "modelTitle": "this model"},
        )
        remember_target(self._project_identity, chosen)
        if always:
            remembered = dict(STATE.settings().get("always", {}))
            remembered[model_id] = True
            STATE.save_settings({"always": remembered})
        self._post({"command": "result", "ok": True, "message": message})
        self._send_state()


# --- The pages --------------------------------------------------------------
#
# Self-contained HTML (the window loads no external resources) and themed from
# the host-injected --orca-* variables, with fallbacks so the same markup is
# previewable in a plain browser while working on it.

BASE_CSS = r"""
  :root {
    --bg:        var(--orca-bg, #ffffff);
    --fg:        var(--orca-fg, #1f2429);
    --muted:     var(--orca-muted, #6b7580);
    --border:    var(--orca-border, #d9dee3);
    --accent:    var(--orca-accent, #009688);
    --accent-fg: var(--orca-accent-fg, #ffffff);
    --ui:        var(--orca-font, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif);
    --mono:      ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:     var(--orca-bg, #2b2d30);
      --fg:     var(--orca-fg, #e4e6e8);
      --muted:  var(--orca-muted, #9aa0a6);
      --border: var(--orca-border, #3d4043);
    }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:16px; background:var(--bg); color:var(--fg); font:13px/1.5 var(--ui); }
  h1 { font-size:15px; margin:0 0 4px; }
  h2 { font-size:13px; margin:0 0 6px; }
  p { margin:0 0 8px; }
  .muted { color:var(--muted); }
  .mono { font-family:var(--mono); font-size:12px; }
  button { font:inherit; padding:5px 12px; cursor:pointer; border-radius:6px;
           background:var(--accent); color:var(--accent-fg); border:1px solid var(--accent); }
  button.secondary { background:transparent; color:var(--fg); border-color:var(--border); }
  button:disabled { opacity:.55; cursor:default; }
  input, select { font:inherit; color:var(--fg); background:var(--bg);
                  border:1px solid var(--border); border-radius:6px; padding:5px 8px; }
  label { display:block; margin-bottom:8px; }
  label > span { display:block; margin-bottom:3px; }
  .card { border:1px solid var(--border); border-radius:8px; padding:12px; margin-bottom:12px; }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .grow { flex:1 1 220px; min-width:0; }
  .bar { height:4px; border-radius:2px; background:var(--border); overflow:hidden; margin-top:8px; }
  .bar > i { display:block; height:100%; width:0; background:var(--accent); transition:width .15s; }
  .note { border-radius:6px; padding:8px 10px; margin-bottom:12px; }
  .note.ok { background:color-mix(in srgb, var(--accent) 12%, transparent); }
  .note.err { background:color-mix(in srgb, #e5484d 16%, transparent); }
  :focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
"""

REVIEW_HTML = (
    """<style>"""
    + BASE_CSS
    + """</style>
<h1>Print Vault</h1>
<p class="muted">Send what you just worked out \u2014 process settings, filaments and colours,
where things sit on the plate \u2014 back to the model\u2019s own .3mf, as a new revision.</p>
<div id="note"></div>
<div id="setup"></div>
<div id="project"></div>
<div id="pending"></div>
<div id="exports"></div>
<div class="card">
  <h2>After every slice</h2>
  <label><span>What should happen</span>
    <select id="mode">
      <option value="ask">Queue it and ask me here</option>
      <option value="auto">Push automatically when the model is certain</option>
      <option value="off">Do nothing</option>
    </select>
  </label>
  <label class="row"><input type="checkbox" id="prompt" style="width:auto">
    <span style="margin:0">Open this window automatically after slicing (experimental)</span></label>
  <label class="row"><input type="checkbox" id="gcode" style="width:auto">
    <span style="margin:0">Put the sliced G-code inside the .3mf, so the stored file is printable
    as it stands (adds tens of MB per revision)</span></label>
  <button class="secondary" id="save-settings">Save</button>
</div>
<script>
let S = { pending: [], always: {}, configured: false };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
}

function via(v) {
  return v === 'hash' ? 'exact file match'
       : v === 'filename' ? 'same filename'
       : v === 'remembered' ? 'where you sent this project last time'
       : v === 'search' ? 'found by name' : 'same source design';
}

function renderSetup() {
  const el = document.getElementById('setup');
  if (S.configured) {
    el.innerHTML = '<p class="muted">Connected to <span class="mono">' + esc(S.url) +
      '</span> · <button class="secondary" id="forget">Change</button></p>';
    document.getElementById('forget').onclick = () => { S.configured = false; renderSetup(); };
    return;
  }
  el.innerHTML =
    '<div class="card"><h2>Connect to Print Vault</h2>' +
    '<label><span>Instance URL</span><input id="url" class="grow" placeholder="https://vault.example.com" value="' + esc(S.url || '') + '"></label>' +
    '<label><span>Push token (Settings &rarr; Push from slicer)</span><input id="token" class="grow" placeholder="pvpush_..."></label>' +
    '<button id="connect">Test and save</button></div>';
  document.getElementById('connect').onclick = () => {
    orca.postMessage({ command:'setup', url: document.getElementById('url').value,
                       token: document.getElementById('token').value });
  };
}

// The project on the plate, and the one button this window exists for. A sync
// is only ever as current as OrcaSlicer\u2019s last checkpoint of the project, so
// the age of that checkpoint is shown rather than hidden.
function renderProject() {
  const el = document.getElementById('project');
  if (!S.configured) { el.innerHTML = ''; return; }
  const p = S.project || {};
  const cands = S.projectCandidates || [];
  if (!p.hasCheckpoint || p.pendingSnapshot) {
    el.innerHTML = '<div class="card"><h2>The project on the plate</h2>' +
      (p.pendingSnapshot
        ? '<p class="muted">OrcaSlicer has not written a project snapshot yet \u2014 it writes one a ' +
          'few seconds after the first change to a project. Change something on the plate, then ' +
          '<button class="secondary" id="recheck">check again</button>.</p>'
        : '<p class="muted">No project checkpoint found. OrcaSlicer keeps one while a project is ' +
          'open \u2014 check <strong>Preferences \u2192 Auto backup</strong>. Without it the settings ' +
          'and the layout cannot be read, and only the files below can be pushed.</p>') +
      '</div>';
    const recheck = document.getElementById('recheck');
    if (recheck) recheck.onclick = () => orca.postMessage({ command:'state' });
    return;
  }
  const age = p.ageSeconds < 90 ? p.ageSeconds + ' s ago' : Math.round(p.ageSeconds / 60) + ' min ago';
  const plates = (p.plates || []).length;
  const ready = cands.length && !p.originMissing;
  // What the one button will send, spelled out: the checkpoint (settings,
  // filaments, layout) plus whatever the last slice added to it.
  const contents = '<ul class="muted" style="margin:0 0 8px;padding-left:18px">' +
    '<li>Settings, filaments and layout \u2014 checkpointed ' + esc(age) +
      (p.dirty ? ', with changes since (the sync waits for the next one)' : '') + '</li>' +
    (plates ? '<li>Slice predictions for ' + plates + ' plate' + (plates === 1 ? '' : 's') + '</li>' : '') +
    (p.queuedSummary
      ? '<li>From your last slice: ' + esc(p.queuedSummary) + '</li>'
      : (plates ? '' : '<li>No slice predictions yet \u2014 slice a plate to include them</li>')) +
    '</ul>';
  el.innerHTML = '<div class="card"><h2>The project on the plate</h2>' +
    (p.originName ? '<p class="mono">' + esc(p.originName) + '</p>' : '') + contents +
    (p.originMissing
      ? '<p class="muted">The file this project was opened from is gone, so there are no meshes to ' +
        'merge the changes into. Re-download it from Print Vault, or push an exported file below.</p>'
      : (cands.length
          ? modelPicker(cands, 'project')
          : '<p class="muted">Match the open plate to choose the model this belongs to.</p>') +
        '<div class="row">' +
          '<button id="sync"' + (ready ? '' : ' disabled') + '>Update the model\u2019s file</button>' +
          '<button class="secondary" id="rematch">Match the open plate</button>' +
          (p.queuedId ? '<button class="secondary" id="drop-slice">Drop the queued slice</button>' : '') +
          '<label class="row" style="margin:0"><input type="checkbox" id="sync-always" style="width:auto">' +
          '<span style="margin:0" class="muted">always, without asking</span></label>' +
        '</div><div class="bar"><i data-bar="' + esc(p.queuedId || 'project') + '"></i></div>') +
    '</div>';
  const sync = document.getElementById('sync');
  if (sync) sync.onclick = () => {
    sync.disabled = true;
    const pick = el.querySelector('[data-pick="project"]');
    // One push either way: with a queued slice it carries that slice's G-code
    // and estimate; without one it is the project as it stands.
    orca.postMessage({ command:'sync', id: p.queuedId || '', modelId: pick ? pick.value : '',
                       always: document.getElementById('sync-always').checked });
  };
  const rematch = document.getElementById('rematch');
  if (rematch) rematch.onclick = () => orca.postMessage({ command:'project' });
  const drop = document.getElementById('drop-slice');
  if (drop) drop.onclick = () => orca.postMessage({ command:'discard', id: p.queuedId });
}

function renderPending() {
  const el = document.getElementById('pending');
  if (!S.pending.length) {
    // Nothing to say: a sync for the project on the plate is that card's
    // button, and this list is only for slices from some *other* project.
    el.innerHTML = '';
    return;
  }

  // Only ever syncs for projects other than the one on the plate: that one's
  // sync is the button on its own card above. Grouped by target model, since
  // two checkpoints can belong to the same one.
  const groups = new Map();
  for (const p of S.pending) {
    const key = p.candidates.length ? p.candidates[0].modelId : '';
    if (!groups.has(key)) groups.set(key, { candidates: p.candidates, items: [] });
    groups.get(key).items.push(p);
  }

  el.innerHTML = [...groups.entries()].map(([key, g]) => {
    const title = g.candidates.length ? esc(g.candidates[0].modelTitle) : 'No matching model';
    const picker = g.candidates.length
      ? modelPicker(g.candidates, 'g-' + key)
      : '<p class="muted">Nothing identifies these projects. Search for a model by name below, ' +
        'then push them from there.</p>';
    const rows = g.items.map(p =>
      '<li class="row" style="justify-content:space-between;border-top:1px solid var(--border);padding:6px 0">' +
      '<span class="grow"><span class="mono">' + esc(p.filename) + '</span>' +
      '<br><span class="muted">' + esc(p.summary) + '</span></span>' +
      '<span class="row">' +
      '<button data-sync="' + esc(p.id) + '" data-group="' + esc(key) + '"' +
        (g.candidates.length ? '' : ' disabled') + '>Update the model\u2019s file</button>' +
      '<button class="secondary" data-discard="' + esc(p.id) + '">Discard</button>' +
      '</span><div class="bar" style="flex-basis:100%"><i data-bar="' + esc(p.id) + '"></i></div></li>').join('');
    return '<div class="card">' +
      '<h2>Another project \u2192 ' + title + '</h2>' +
      '<p class="muted">Sliced from a project that is not the one on the plate. Its checkpoint is ' +
      'still on disk, so it can go back to its model from here.</p>' + picker +
      '<div class="row">' +
        '<button class="secondary" data-discardall="' + esc(key) + '">Keep all local</button>' +
        '<label class="row" style="margin:0"><input type="checkbox" data-always="' + esc(key) + '" style="width:auto">' +
        '<span style="margin:0" class="muted">always, without asking</span></label>' +
      '</div>' +
      '<ul style="list-style:none;padding:0;margin:8px 0 0">' + rows + '</ul></div>';
  }).join('');

  const picked = key => {
    const sel = el.querySelector('[data-pick="g-' + key + '"]');
    return sel ? sel.value : '';
  };
  const always = key => {
    const box = el.querySelector('[data-always="' + key + '"]');
    return !!(box && box.checked);
  };
  el.querySelectorAll('[data-sync]').forEach(b => b.onclick = () => {
    b.disabled = true;
    orca.postMessage({ command:'sync', id: b.dataset.sync, modelId: picked(b.dataset.group),
                       always: always(b.dataset.group) });
  });
  el.querySelectorAll('[data-discard]').forEach(b => b.onclick = () =>
    orca.postMessage({ command:'discard', id: b.dataset.discard }));
  el.querySelectorAll('[data-discardall]').forEach(b => b.onclick = () => {
    const key = b.dataset.discardall;
    const group = [...groups.entries()].find(([k]) => k === key);
    if (group) group[1].items.forEach(p => orca.postMessage({ command:'discard', id: p.id }));
  });
}

function modelPicker(list, key) {
  return '<label><span>Model</span><select data-pick="' + esc(key) + '" class="grow">' +
    list.map(c => '<option value="' + esc(c.modelId) + '">' + esc(c.modelTitle) + ' \u2014 ' + via(c.via) + '</option>').join('') +
    '</select></label>';
}

function renderExports() {
  const el = document.getElementById('exports');
  if (!S.configured) { el.innerHTML = ''; return; }
  const list = S.exports || [];
  const cands = S.projectCandidates || [];
  const searchRow =
    '<div class="row" style="margin-bottom:8px">' +
      '<input id="q" class="grow" placeholder="Find a model by name\u2026" value="">' +
      '<button class="secondary" id="find">Search</button>' +
    '</div>';
  const head =
    '<div class="card"><h2>Exported files on this machine</h2>' +
    '<p class="muted">Push a project you already exported \u2014 the fallback for when there is no ' +
    'checkpoint to read. Files are matched to whatever is open on the plate right now. For a ' +
    'multi-plate project use <strong>Export all plates sliced file</strong>, which gives one .3mf ' +
    'covering every plate; it revises the model\u2019s own file and keeps its name.</p>' +
    '<div class="row" style="margin-bottom:8px">' +
      '<button class="secondary" id="match">Match the open plate</button>' +
      (cands.length ? '<span class="muted">' + esc(cands[0].modelTitle) + ' \u2014 ' + via(cands[0].via) + '</span>' : '') +
    '</div>' + searchRow;
  const body = !list.length
    ? '<p class="muted">Nothing recent in ' + esc((S.exportDirs || ['Downloads, Desktop']).join(', ')) + '.</p>'
    : (cands.length ? modelPicker(cands, 'exports')
                    : '<p class="muted">Match the open plate, or search by name, to choose a model. ' +
                      'A file the catalogue has no hash for (anything uploaded before hashing was added) ' +
                      'will not match on its own.</p>') +
      '<ul style="list-style:none;padding:0;margin:0">' + list.map(f =>
        '<li class="row" style="justify-content:space-between;border-top:1px solid var(--border);padding:6px 0">' +
        '<span class="grow"><span class="mono">' + esc(f.filename) + '</span><br><span class="muted">' +
        f.sizeMb + ' MB \u00b7 project</span></span>' +
        '<span class="row">' +
        '<button data-file="' + esc(f.path) + '"' + (cands.length ? '' : ' disabled') + '>Push</button>' +
        '</span><div class="bar" style="flex-basis:100%"><i data-bar="' + esc(f.path) + '"></i></div></li>').join('') +
      '</ul>';
  el.innerHTML = head + body + '</div>';

  document.getElementById('match').onclick = () => orca.postMessage({ command:'project' });
  const runSearch = () => orca.postMessage({ command:'search', query: document.getElementById('q').value });
  document.getElementById('find').onclick = runSearch;
  document.getElementById('q').onkeydown = e => { if (e.key === 'Enter') runSearch(); };
  el.querySelectorAll('[data-file]').forEach(b => b.onclick = () => {
    const pick = el.querySelector('[data-pick="exports"]');
    b.disabled = true;
    orca.postMessage({ command:'pushfile', path: b.dataset.file,
                       modelId: pick ? pick.value : '', always: false });
  });
}

function note(ok, message) {
  document.getElementById('note').innerHTML =
    '<div class="note ' + (ok ? 'ok' : 'err') + '">' + esc(message) + '</div>';
}

document.getElementById('save-settings').onclick = () =>
  orca.postMessage({ command:'settings', mode: document.getElementById('mode').value,
                     promptAfterSlice: document.getElementById('prompt').checked,
                     includeGcode: document.getElementById('gcode').checked });

orca.onMessage(msg => {
  if (msg.command === 'state') {
    S = Object.assign(S, msg.data);
    document.getElementById('mode').value = S.mode || 'ask';
    document.getElementById('prompt').checked = !!S.promptAfterSlice;
    document.getElementById('gcode').checked = !!S.includeGcode;
    renderSetup();
    renderProject();
    renderPending();
    renderExports();
  } else if (msg.command === 'result') {
    note(msg.ok, msg.message);
  } else if (msg.command === 'progress') {
    const bar = document.querySelector('[data-bar="' + msg.id + '"]');
    if (bar) bar.style.width = Math.round(msg.fraction * 100) + '%';
  }
});

orca.postMessage({ command:'state' });
</script>"""
)

POINTER_HTML = (
    """<style>"""
    + BASE_CSS
    + """</style>
<h1>Nothing to configure here</h1>
<p>Print Vault's settings — instance URL, push token, and what happens after
each slice — live on the <strong>Push sliced file to Print Vault</strong>
capability, listed above this one. Both capabilities read the same
configuration.</p>
<p class="muted">This window is opened with the &#9655; Run button next to this
capability in the plugin list, or from the Actions Speed Dial \u2014 pin it there
as a favourite and it is one click from the plate. It is where the project on
the plate is pushed back to its model.</p>"""
)

CONFIG_HTML = (
    """<style>"""
    + BASE_CSS
    + """</style>
<h1>Print Vault</h1>
<p class="muted">Where sliced files are sent, and what happens after each slice.</p>
<label><span>Instance URL</span><input id="url" class="grow" placeholder="https://vault.example.com"></label>
<label><span>Push token</span><input id="token" class="grow" placeholder="pvpush_..."></label>
<p class="muted">The token is kept in the plugin\u2019s own folder, not in this configuration:
OrcaSlicer saves a capability\u2019s config with your <em>print profile</em>, which would write
the credential into every project you save or export.</p>
<label><span>After every slice</span>
  <select id="mode">
    <option value="ask">Queue it and ask me (run "Print Vault: review &amp; push")</option>
    <option value="auto">Push automatically when the model is certain</option>
    <option value="off">Do nothing</option>
  </select>
</label>
<label class="row"><input type="checkbox" id="prompt" style="width:auto">
  <span style="margin:0">Open this window automatically after slicing (experimental)</span></label>
<label class="row"><input type="checkbox" id="gcode" style="width:auto">
  <span style="margin:0">Put the sliced G-code inside the .3mf that is pushed</span></label>
<label><span>Never keep a G-code larger than (MB)</span><input id="max" type="number" min="16" step="16"></label>
<button id="save">Save</button>
<p class="muted" id="status"></p>
<script>
// The config-UI bridge is synchronous: getConfig() returns the stored object
// and onConfig() fires immediately, then again whenever the host replaces it
// (a "Restore defaults", or a preset-scoped override being applied).
let current = {};
orca.onConfig(cfg => {
  current = cfg || {};
  document.getElementById('url').value = current.url || '';
  document.getElementById('token').value = current.token || '';
  document.getElementById('mode').value = current.mode || 'ask';
  document.getElementById('prompt').checked = !!current.prompt_after_slice;
  document.getElementById('gcode').checked = !!current.include_gcode;
  document.getElementById('max').value = current.max_queue_mb || 1024;
});
if (orca.getContext().readOnly) {
  document.querySelectorAll('input, select, button').forEach(el => el.disabled = true);
  document.getElementById('status').textContent = 'This configuration is read-only here.';
}
document.getElementById('save').onclick = () => {
  const next = Object.assign({}, current, {
    url: document.getElementById('url').value.trim().replace(/\\/+$/, ''),
    token: document.getElementById('token').value.trim(),
    mode: document.getElementById('mode').value,
    prompt_after_slice: document.getElementById('prompt').checked,
    include_gcode: document.getElementById('gcode').checked,
    max_queue_mb: Number(document.getElementById('max').value) || 1024,
  });
  orca.saveConfig(next);
  current = next;
  document.getElementById('status').textContent = 'Saved.';
};
</script>"""
)


# --- Registration -----------------------------------------------------------

if orca is not None:

    @orca.plugin
    class PrintVaultPackage(orca.base):
        def register_capabilities(self):
            orca.register_capability(PrintVaultSlicePush)
            orca.register_capability(PrintVaultSync)


# --- Stand-alone CLI --------------------------------------------------------
#
# The plugin system only exists in OrcaSlicer 2.5 nightlies and later. On
# anything older — and on Bambu Studio and PrusaSlicer, which have no plugin
# system at all — the same file runs as a post-processing script:
#
#   Print Settings -> Others -> Post-processing Scripts
#   python3 /path/to/orca_print_vault_plugin_any.py --url "https://…" --token "pvpush_…" ;
#
# It is the weaker half of this feature by design: a post-processing script
# cannot ask a question, and cannot see which project is open, so it resolves
# the target from the sliced file's own name and pushes only when that is
# unambiguous. Never fatal — a push problem must not break someone's print, so
# every failure path still exits 0 unless --strict is given.


def _cli_settings(args) -> dict:
    """Command-line flags win; anything omitted falls back to the same
    settings.json the plugin writes, so a machine that later gets a nightly
    keeps working without being reconfigured."""
    settings = STATE.settings()
    if args.url:
        settings["url"] = args.url.rstrip("/")
    if args.token:
        settings["token"] = args.token
    return settings


def _newest_checkpoint() -> dict | None:
    """The most recent checkpoint on this machine, whoever wrote it.

    Inside OrcaSlicer the pid in `lock.txt` settles which project is ours;
    from the CLI there is no such thing, so recency is all there is to go on.
    """
    newest: dict | None = None
    for root in _checkpoint_roots():
        for pattern in CHECKPOINT_GLOBS:
            for directory in glob.glob(os.path.join(root, pattern)):
                found = checkpoint_at(directory)
                # Only one with a snapshot is any use here.
                if not found or not found.get("ready"):
                    continue
                if newest is None or found["mtime"] > newest["mtime"]:
                    newest = found
    return newest


def _cli_sync(args, client: VaultClient, failure: int, checkpoint: dict | None = None) -> int:
    """`--sync`: push the project itself rather than a G-code file.

    Two uses. A slicer without a plugin system still keeps a project
    checkpoint on disk, so the round trip is available there too (as a manual
    step — a post-processing script cannot be trusted with it, since it cannot
    tell which project the file came from). And `--out` assembles the file
    without pushing anything, which is how the merge is checked without a
    slicer or an instance in the loop.
    """
    checkpoint = (
        checkpoint
        or (checkpoint_at(args.checkpoint) if args.checkpoint else None)
        or _newest_checkpoint()
    )
    if not checkpoint:
        log("no OrcaSlicer project checkpoint found — is a project open, and is Auto backup on?")
        return failure
    if not checkpoint.get("ready"):
        log(
            f"{checkpoint['dir']} holds no project snapshot yet — OrcaSlicer writes one a few "
            "seconds after the first change to the project"
        )
        return failure
    origin = args.origin or checkpoint.get("origin")
    if not origin:
        log(f"{checkpoint['dir']} has no origin.txt — pass --origin <the project's .3mf>")
        return failure
    log(f"checkpoint {checkpoint['dir']} (origin {origin})")

    if args.out:
        result = assemble_project(origin, checkpoint, args.out)
        log(
            f"wrote {args.out}: {result['bytes'] // (1 << 20)} MB, {result['parts']} parts, "
            f"{result['meshesFromOrigin']} mesh(es) transplanted from the origin"
        )
        return 0

    identity = checkpoint_identity(
        {"hashes": [], "filenames": [], "designId": None}, checkpoint
    )
    model_id = args.model
    if not model_id:
        candidates = client.resolve(
            identity["hashes"], identity["filenames"], identity["designId"]
        )
        if len(candidates) != 1:
            log(
                f"{len(candidates)} models match {os.path.basename(origin)} — pass --model <id>"
            )
            return failure
        model_id = candidates[0]["modelId"]
        log(f"matched {candidates[0]['modelTitle']}")

    entry = {
        "kind": "sync",
        "checkpoint": checkpoint["dir"],
        "origin": origin,
        "filename": os.path.basename(origin),
        "plates": checkpoint_plates(checkpoint),
        "identity": identity,
    }
    log(sync_push(entry, model_id, client=client))
    return 0


def main(argv: list[str]) -> int:
    import argparse

    parser = argparse.ArgumentParser(
        description="Push a freshly sliced file back to its model in Print Vault.",
    )
    parser.add_argument("file", nargs="?", help="the sliced file (the slicer appends this)")
    parser.add_argument("--url", default="", help="instance URL, e.g. https://vault.example.com")
    parser.add_argument("--token", default="", help="push token from Settings -> Push from slicer")
    parser.add_argument("--model", default="", help="push to this model id instead of resolving one")
    parser.add_argument(
        "--save",
        action="store_true",
        help="store --url/--token for next time (and for the plugin, on this machine)",
    )
    parser.add_argument("--check", action="store_true", help="verify the connection and exit")
    parser.add_argument(
        "--sync",
        action="store_true",
        help="push the open project (settings, filaments, plate layout) from OrcaSlicer's "
        "checkpoint, instead of a sliced G-code file",
    )
    parser.add_argument(
        "--checkpoint",
        default="",
        help="with --sync: the checkpoint directory (default: the newest on this machine)",
    )
    parser.add_argument(
        "--origin",
        default="",
        help="with --sync: the .3mf the project was opened from (default: its origin.txt)",
    )
    parser.add_argument(
        "--out",
        default="",
        help="with --sync: write the assembled project here and stop, pushing nothing",
    )
    parser.add_argument(
        "--push-gcode",
        action="store_true",
        help="send the given G-code file as-is instead of syncing the project it came from "
        "(a raw .gcode is stored next to the model's file, not as a revision of it)",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="exit non-zero on failure — for testing the setup, not for daily use",
    )
    args = parser.parse_args(argv)

    settings = _cli_settings(args)
    client = VaultClient(settings.get("url", ""), settings.get("token", ""))
    failure = 1 if args.strict else 0

    try:
        if args.save:
            STATE.save_settings({"url": client.url, "token": client.token})
            log(f"settings saved to {STATE.settings_path()}")
        if args.check:
            answer = client.ping()
            log(f"connected to {answer.get('origin', client.url)} as {answer.get('user') or 'unknown'}")
            return 0
        if args.sync:
            return _cli_sync(args, client, failure)
        if not args.file:
            if args.save:
                return 0
            parser.error("a file to push is required")
        path = args.file
        if not os.path.exists(path):
            log(f"no such file: {path}")
            return failure
        # A post-processing script is handed a `.gcode`, and a raw `.gcode` is
        # not what belongs in the catalogue: on a Bambu printer that artifact
        # sits *inside* the project checkpoint, and everywhere else there is
        # still one on disk, so sync the project instead. --push-gcode is the
        # explicit way to send the file itself.
        if not args.push_gcode and not path.lower().endswith(PUSH_SUFFIXES):
            checkpoint = project_checkpoint(path) or _newest_checkpoint()
            if checkpoint:
                log(f"syncing the project instead of {os.path.basename(path)}")
                return _cli_sync(args, client, failure, checkpoint=checkpoint)
            log(
                "no project checkpoint found, so there is nothing to sync — turn on "
                "Preferences -> Auto backup, or pass --push-gcode to send the G-code itself"
            )
            return failure
        filename = push_filename(path, os.environ.get("SLIC3R_PP_OUTPUT_NAME"))
        if not filename.lower().endswith(ALLOWED_SUFFIXES):
            log(f"not a pushable artifact: {filename}")
            return failure

        model_id = args.model
        if not model_id:
            # Without the slicer's project state this is all there is to go on.
            candidates = client.resolve([], [filename], None)
            if len(candidates) != 1:
                log(
                    f"{len(candidates)} models match {filename} — "
                    "pass --model <id>, or install the plugin, which resolves this exactly."
                )
                return failure
            model_id = candidates[0]["modelId"]
            log(f"matched {candidates[0]['modelTitle']}")

        message = push_entry(
            {"path": path, "filename": filename, "meta": None}, model_id, client=client
        )
        log(message)
        return 0
    except VaultError as exc:
        log(str(exc))
        return failure
    except Exception as exc:  # noqa: BLE001 - never break a print
        log(f"unexpected failure: {exc}")
        return failure


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
