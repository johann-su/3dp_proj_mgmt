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
result back: after a slice it works out which catalogue model the open project
came from, asks whether to update it, and uploads the G-code as a new versioned
revision with the printer, presets and estimates attached.

Why a plugin and not a post-processing script
---------------------------------------------
The first version of this was a post-processing script, and the mechanism was
the problem. That field lives on the *process preset*, while the push target is
a *model* — so a per-model token meant editing (and dirtying) your print
profile every time you sliced something else. A plugin is installed once,
keeps its credential in its own config, and can ask the slicer which project is
open. Setup is per machine, not per model.

How the target is worked out
----------------------------
`orca.host.model()` gives every object's `input_file` (the path it was loaded
from) and the Bambu `design_id` in the 3MF. A file the catalogue served is
byte-identical to the stored object, so the SHA-256 of what is on disk matches
`model_files.content_hash` on the server and `/api/slice-push/resolve` answers
with the model. Filename and design-id matches are offered as weaker
candidates; only a single hash match is ever pushed to without asking.

Where the artifact comes from, and what it is not
-------------------------------------------------
`Step.psGCodePostProcess` is the only seam that hands over sliced output. It
fires from the G-code **export** path after the classic post-processing
scripts — *not* from slicing. "Slice plate" alone never reaches a plugin; the
step runs when the sliced file is exported ("Print plate -> Export plate sliced
file", File -> Export -> Export G-code) or uploaded to a printer. `ctx.gcode_path`
points at a *temporary working copy* — there is no
project `.3mf` and no `.gcode.3mf` bundle at that moment, and `ctx.print` /
`ctx.object` are None. So what gets pushed is G-code. The settings that
produced it are read live from `orca.host.preset_bundle()` and sent alongside
as metadata, which is more than the file itself would have told us.

The step can also fire more than once per slice (export and upload each run it
on their own working copy), so a push is keyed on the output name and repeat
pushes of the same plate replace that file server-side rather than piling up.

The UI rule that shapes everything
----------------------------------
`SlicingPipelinePluginCapability` runs on the slicing worker thread, and the
docs are explicit: do not call `orca.host.ui.*` from there — the UI thread can
be blocked waiting on that worker, so a marshaled UI call can deadlock. The
"update the catalogue or keep it local?" question therefore *cannot* be asked
from the hook. Hence three modes:

  ask (default)  the hook queues the slice; you answer in the plugin's own
                 window (Plugins -> Print Vault -> Run, or the Speed Dial)
  auto           the hook pushes immediately when the match is unambiguous and
                 you have said "always" for that model; never asks
  off            capture nothing

`prompt_after_slice` additionally tries to raise the question by itself from a
short-lived thread once the pipeline has returned. That is the one piece of
this that leans on undocumented behaviour — it is off by default and reported
upstream in OrcaSlicer discussion #14878.

Running it outside OrcaSlicer
-----------------------------
The same file is a stand-alone CLI (`python3 orca_print_vault_plugin_any.py
--help`), because OrcaSlicer 2.4.2 and Bambu Studio/PrusaSlicer have no plugin
system. There it behaves like the old post-processing script: pass it as a
post-processing command and it resolves and pushes the file it is handed.
Stdlib only — slicers ship no Python environment of their own.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

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
    # Experimental: raise the review window by itself after a slice. Off by
    # default; the pipeline hook may not legally touch the UI.
    "prompt_after_slice": False,
    # Never copy a working G-code larger than this into the queue. A deferred
    # push has to keep its own copy (the slicer deletes the temp file), and a
    # runaway plate should not fill the user's disk.
    "max_queue_mb": 1024,
    # Models the user has said "always push this one" for: {model_id: True}.
    "always": {},
    # Folders scanned for already-exported sliced files, so the review window
    # can push one without the slicing hook having run at all. Empty means the
    # defaults below.
    "export_dirs": [],
}


def default_export_dirs() -> list[str]:
    """Where OrcaSlicer's "Export plate sliced file" lands by default. Only
    ever read, never written."""
    home = os.path.expanduser("~")
    return [os.path.join(home, "Downloads"), os.path.join(home, "Desktop")]

# Slice artifacts the ingest endpoint accepts.
ALLOWED_SUFFIXES = (".gcode", ".3mf")

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

    def resolve(self, hashes: list[str], filenames: list[str], design_id: str | None) -> list[dict]:
        payload = json.dumps(
            {"hashes": hashes, "filenames": filenames, "designId": design_id}
        ).encode("utf-8")
        answer = self._request(
            "POST",
            "/api/slice-push/resolve",
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        return answer.get("candidates", [])

    def push(self, model_id: str, path: str, filename: str, meta: dict | None, on_progress=None) -> dict:
        """Uploads the artifact as a new revision of `model_id`. Streams from
        disk — a sliced G-code is routinely hundreds of MB and must never be
        read into memory."""
        size = os.path.getsize(path)
        query = urllib.parse.urlencode({"filename": filename})
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
# The two capabilities (the slicing hook and the review window) are separate
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
        self._storage: str | None = None

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
                    merged.update(stored)
            except Exception:
                pass
        return merged

    def save_settings(self, values: dict) -> None:
        """Persists to both places: the capability config (what the Config tab
        shows) and the on-disk mirror (what the window and the CLI read)."""
        merged = dict(self.settings())
        merged.update(values)
        with self.lock:
            owner = self.config_owner
            if owner is not None:
                try:
                    owner.save_config(json.dumps(merged))
                except Exception as exc:
                    log(f"could not save capability config: {exc}")
            try:
                with open(self.settings_path(), "w", encoding="utf-8") as handle:
                    json.dump(merged, handle, indent=2)
            except OSError as exc:
                log(f"could not write settings.json: {exc}")

    def client(self) -> VaultClient:
        settings = self.settings()
        return VaultClient(settings.get("url", ""), settings.get("token", ""))

    # --- the pending queue ---
    #
    # A deferred push must keep its own copy of the G-code: the file the hook
    # is handed is a temporary working copy the slicer deletes once the export
    # finishes. Entries are a JSON sidecar plus the copied artifact.

    def queue_add(self, entry: dict, source_path: str, max_bytes: int) -> dict | None:
        size = os.path.getsize(source_path)
        if size > max_bytes:
            log(
                f"not queueing {entry['filename']}: {size // (1 << 20)} MB exceeds the "
                f"{max_bytes // (1 << 20)} MB queue limit (raise max_queue_mb, or use mode 'auto')"
            )
            return None
        entry_id = uuid.uuid4().hex
        stored = os.path.join(self.queue_dir(), f"{entry_id}{os.path.splitext(source_path)[1]}")
        try:
            shutil.copyfile(source_path, stored)
        except OSError as exc:
            log(f"could not stage {entry['filename']}: {exc}")
            return None
        entry = {**entry, "id": entry_id, "path": stored, "size": size, "queuedAt": time.time()}
        try:
            with open(os.path.join(self.queue_dir(), f"{entry_id}.json"), "w", encoding="utf-8") as handle:
                json.dump(entry, handle, indent=2)
        except OSError as exc:
            log(f"could not write queue entry: {exc}")
            return None
        return entry

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
            # A queue entry whose artifact is gone is noise, not history.
            if os.path.exists(entry.get("path", "")):
                entries.append(entry)
            else:
                self.queue_remove(entry.get("id", ""))
        entries.sort(key=lambda e: e.get("queuedAt", 0), reverse=True)
        return entries

    def queue_get(self, entry_id: str) -> dict | None:
        return next((e for e in self.queue_list() if e.get("id") == entry_id), None)

    def queue_remove(self, entry_id: str) -> None:
        if not entry_id:
            return
        for path in (
            os.path.join(self.queue_dir(), f"{entry_id}.json"),
            *[
                os.path.join(self.queue_dir(), f"{entry_id}{suffix}")
                for suffix in ALLOWED_SUFFIXES
            ],
        ):
            try:
                os.remove(path)
            except OSError:
                pass

    def queue_trim(self, keep: int = 10) -> None:
        """Bounded on purpose: the queue holds copies of very large files, and
        a slice nobody answered for a week is not worth the disk."""
        for entry in self.queue_list()[keep:]:
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
        identity["filenames"].append(os.path.basename(path))
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
    reads the config off its context; the review window reads it off the live
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
    """Same, read off the live preset bundle — what the review window has when
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
            if not name.lower().endswith(ALLOWED_SUFFIXES):
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
                }
            )
    found.sort(key=lambda item: item["mtime"], reverse=True)
    return found[:limit]


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
    )
    verb = "Replaced" if answer.get("status") == "replaced" else "Added"
    minutes = answer.get("printTimeSeconds")
    detail = f" ({int(minutes) // 60} min)" if isinstance(minutes, (int, float)) else ""
    return f"{verb} {entry['filename']}{detail}"


def push_filename(gcode_path: str, output_name: str | None) -> str:
    """What the revision is stored as. The slicer's chosen output name is the
    readable one ("Benchy_plate_1.gcode"); the temp file it hands over is
    named for nothing. The extension follows the *bytes*, not the name, because
    a Bambu-style setup calls its export .gcode.3mf while what we hold here is
    plain G-code."""
    name = os.path.basename((output_name or "").strip()) or os.path.basename(gcode_path)
    suffix = os.path.splitext(gcode_path)[1].lower()
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

    Cannot show UI (see the module docstring), so it either pushes silently —
    when the model is unambiguous and the user has already said yes to it — or
    queues the artifact for the review window. It never raises: a failed push
    must not break a print.
    """

    def __init__(self):
        super().__init__()
        # (filename, size) of the last artifact handled, with a timestamp. The
        # post-process step can fire twice for one slice (file export and
        # upload each get their own working copy), and each firing would
        # otherwise become its own revision.
        self._last: tuple[str, int, float] | None = None

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

        client = STATE.client()
        if not client.configured():
            return orca.ExecutionResult.success(
                "Print Vault: not set up — add the instance URL and a push token in the plugin's Config tab"
            )

        filename = push_filename(ctx.gcode_path, getattr(ctx, "output_name", ""))
        size = os.path.getsize(ctx.gcode_path)
        # Logged unconditionally: when someone asks "why did nothing happen?",
        # the answer is almost always that they sliced without exporting, and
        # the absence of this line in Diagnostics is what proves it.
        log(f"handling export of {filename} ({size // (1 << 20)} MB, host={getattr(ctx, 'host', '') or '?'})")
        now = time.time()
        if self._last and self._last[0] == filename and self._last[1] == size and now - self._last[2] < 60:
            return orca.ExecutionResult.success("Print Vault: already handled this export")
        self._last = (filename, size, now)

        identity = collect_identity()
        try:
            candidates = client.resolve(
                identity["hashes"], identity["filenames"], identity["designId"]
            )
        except VaultError as exc:
            log(str(exc))
            candidates = []

        entry = {
            "filename": filename,
            "outputName": getattr(ctx, "output_name", "") or filename,
            "host": getattr(ctx, "host", "") or "",
            "meta": collect_meta(ctx),
            "candidates": candidates,
            "identity": identity,
        }

        # Only a single hash match is ever pushed to unattended: pushing a
        # revision to the wrong model is the one mistake with no cheap undo.
        confident = len(candidates) == 1 and candidates[0].get("via") == "hash"
        model_id = candidates[0]["modelId"] if candidates else None
        always = bool(settings.get("always", {}).get(model_id)) if model_id else False
        mode = settings.get("mode", "ask")

        if confident and (mode == "auto" or always):
            # Straight from the slicer's working copy — no queue, no second
            # copy of a few hundred MB on disk.
            try:
                message = push_entry({**entry, "path": ctx.gcode_path}, model_id, client=client)
                log(message)
                return orca.ExecutionResult.success(f"Print Vault: {message}")
            except VaultError as exc:
                log(f"push failed, queueing instead: {exc}")

        queued = STATE.queue_add(
            entry, ctx.gcode_path, int(settings.get("max_queue_mb", 1024)) * (1 << 20)
        )
        if not queued:
            return orca.ExecutionResult.success("Print Vault: nothing queued")

        if settings.get("prompt_after_slice"):
            self._prompt_later(queued)

        title = candidates[0]["modelTitle"] if candidates else "an unmatched model"
        return orca.ExecutionResult.success(
            f"Print Vault: queued {filename} for {title} — "
            'run "Print Vault: review & push" to send it'
        )

    def _prompt_later(self, entry: dict) -> None:
        """Experimental: ask the question from a thread once the pipeline has
        returned.

        The hook itself must not touch the UI, and there is no "slicing
        finished" event to hang this on — so this waits out the export and then
        raises a native message box. It leans on undocumented timing and is off
        by default; see OrcaSlicer discussion #14878, where the missing event is
        the first thing asked for.
        """

        def run():
            time.sleep(3.0)
            try:
                candidates = entry.get("candidates", [])
                if not candidates:
                    return
                target = candidates[0]
                clicked = orca.host.ui.message(
                    f"{entry['filename']} was sliced.\n\n"
                    f"Update \"{target['modelTitle']}\" in Print Vault with it?",
                    title="Print Vault",
                    buttons="yes_no",
                    icon="question",
                )
                if clicked != "yes":
                    STATE.queue_remove(entry["id"])
                    return
                message = push_entry(entry, target["modelId"])
                STATE.queue_remove(entry["id"])
                orca.host.ui.message(message, title="Print Vault", icon="info")
            except Exception as exc:  # noqa: BLE001
                log(f"deferred prompt failed: {exc}")

        threading.Thread(target=run, name="print-vault-prompt", daemon=True).start()


# --- Capability 2: the review window ---------------------------------------


class PrintVaultReview(orca.script.ScriptPluginCapabilityBase if orca else object):
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

    def get_name(self):
        return "Print Vault: review & push"

    def has_config_ui(self):
        # Every capability gets a Config tab whether it wants one or not, and an
        # empty "{}" JSON editor next to the capability that *does* hold the
        # settings is an invitation to configure the wrong one.
        return True

    def get_config_ui(self):
        return POINTER_HTML

    def execute(self):
        if self.win is not None and self.win.is_open():
            self.win.close()
        self.win = orca.host.ui.create_window(
            REVIEW_HTML,
            title="Print Vault",
            width=760,
            height=620,
            on_message=self.on_message,
            on_close=self._forget,
        )
        return orca.ExecutionResult.success()

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
                    }
                )
                self._send_state()
            elif command == "discard":
                STATE.queue_remove(msg.get("id", ""))
                self._send_state()
            elif command == "push":
                self._run(
                    self._push,
                    msg.get("id", ""),
                    msg.get("modelId", ""),
                    bool(msg.get("always")),
                )
            elif command == "rescan":
                self._run(self._rescan, msg.get("id", ""))
            elif command == "project":
                self._run(self._resolve_project)
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
                    "pending": [
                        {
                            "id": entry.get("id"),
                            "filename": entry.get("filename"),
                            "sizeMb": round(entry.get("size", 0) / (1 << 20), 1),
                            "queuedAt": entry.get("queuedAt"),
                            "candidates": entry.get("candidates", []),
                            "meta": entry.get("meta", {}),
                        }
                        for entry in STATE.queue_list()
                    ],
                },
            }
        )

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
        identity = collect_identity()
        try:
            self._project_candidates = STATE.client().resolve(
                identity["hashes"], identity["filenames"], identity["designId"]
            )
        except VaultError as exc:
            self._post({"command": "result", "ok": False, "message": str(exc)})
            return
        if not self._project_candidates:
            self._post(
                {
                    "command": "result",
                    "ok": False,
                    "message": "Nothing on the plate matches a model in Print Vault.",
                }
            )
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
        if not (inside and os.path.isfile(real) and real.lower().endswith(ALLOWED_SUFFIXES)):
            self._post({"command": "result", "ok": False, "message": "That file is not in a watched export folder"})
            return
        if not model_id:
            self._post({"command": "result", "ok": False, "message": "Pick a model first"})
            return

        entry = {
            "path": real,
            "filename": os.path.basename(real),
            "meta": collect_meta_host(),
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
        if always:
            remembered = dict(STATE.settings().get("always", {}))
            remembered[model_id] = True
            STATE.save_settings({"always": remembered})
        self._post({"command": "result", "ok": True, "message": message})
        self._send_state()

    def _rescan(self, entry_id: str) -> None:
        """Re-run resolution for a queued slice — the answer changes once the
        model exists, or once its file has been uploaded."""
        entry = STATE.queue_get(entry_id)
        if not entry:
            return
        identity = entry.get("identity", {})
        try:
            candidates = STATE.client().resolve(
                identity.get("hashes", []),
                identity.get("filenames", []),
                identity.get("designId"),
            )
        except VaultError as exc:
            self._post({"command": "result", "ok": False, "message": str(exc)})
            return
        entry["candidates"] = candidates
        try:
            with open(os.path.join(STATE.queue_dir(), f"{entry_id}.json"), "w", encoding="utf-8") as handle:
                json.dump(entry, handle, indent=2)
        except OSError:
            pass
        self._send_state()

    def _push(self, entry_id: str, model_id: str, always: bool) -> None:
        entry = STATE.queue_get(entry_id)
        if not entry or not model_id:
            self._post({"command": "result", "ok": False, "message": "That slice is no longer queued"})
            return
        try:
            message = push_entry(
                entry,
                model_id,
                on_progress=lambda fraction: self._post(
                    {"command": "progress", "id": entry_id, "fraction": fraction}
                ),
            )
        except VaultError as exc:
            self._post({"command": "result", "ok": False, "message": str(exc)})
            return
        if always:
            settings = STATE.settings()
            remembered = dict(settings.get("always", {}))
            remembered[model_id] = True
            STATE.save_settings({"always": remembered})
        STATE.queue_remove(entry_id)
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
<p class="muted">Slices waiting for a decision: update the catalogue, or keep them local.</p>
<div id="note"></div>
<div id="setup"></div>
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
    <span style="margin:0">Pop the question right after slicing (experimental)</span></label>
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
       : v === 'filename' ? 'same filename' : 'same source design';
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

function renderPending() {
  const el = document.getElementById('pending');
  if (!S.pending.length) {
    el.innerHTML = '<p class="muted">Nothing queued. A slice reaches this list only once ' +
      '<strong>Push sliced file to Print Vault</strong> is selected under Print Settings \u2192 Others \u2192 ' +
      'Slicing Pipeline Plugin (Advanced mode) for the profile you slice with, and only when you ' +
      '<em>export</em> the sliced file. Until then, use the list below.</p>';
    return;
  }
  el.innerHTML = S.pending.map(p => {
    const options = p.candidates.map(c =>
      '<option value="' + esc(c.modelId) + '">' + esc(c.modelTitle) + ' — ' + via(c.via) + '</option>').join('');
    const picker = p.candidates.length
      ? '<label><span>Model</span><select data-pick="' + esc(p.id) + '" class="grow">' + options + '</select></label>'
      : '<p class="muted">No matching model. Upload this file to a model first, then rescan.</p>';
    const printer = p.meta && p.meta.model ? ' · ' + esc(p.meta.model) : '';
    return '<div class="card" data-entry="' + esc(p.id) + '">' +
      '<h2>' + esc(p.filename) + '</h2>' +
      '<p class="muted">' + p.sizeMb + ' MB' + printer + '</p>' + picker +
      '<div class="row">' +
        '<button data-push="' + esc(p.id) + '"' + (p.candidates.length ? '' : ' disabled') + '>Update catalogue</button>' +
        '<button class="secondary" data-discard="' + esc(p.id) + '">Keep local</button>' +
        '<button class="secondary" data-rescan="' + esc(p.id) + '">Rescan</button>' +
        '<label class="row" style="margin:0"><input type="checkbox" data-always="' + esc(p.id) + '" style="width:auto">' +
        '<span style="margin:0" class="muted">always, without asking</span></label>' +
      '</div><div class="bar"><i data-bar="' + esc(p.id) + '"></i></div></div>';
  }).join('');

  el.querySelectorAll('[data-push]').forEach(b => b.onclick = () => {
    const id = b.dataset.push;
    const pick = el.querySelector('[data-pick="' + id + '"]');
    b.disabled = true;
    orca.postMessage({ command:'push', id, modelId: pick ? pick.value : '',
                       always: el.querySelector('[data-always="' + id + '"]').checked });
  });
  el.querySelectorAll('[data-discard]').forEach(b => b.onclick = () =>
    orca.postMessage({ command:'discard', id: b.dataset.discard }));
  el.querySelectorAll('[data-rescan]').forEach(b => b.onclick = () =>
    orca.postMessage({ command:'rescan', id: b.dataset.rescan }));
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
  const head =
    '<div class="card"><h2>Exported files on this machine</h2>' +
    '<p class="muted">Push a file you already exported, without wiring the plugin into a print profile. ' +
    'Files are matched to whatever is open on the plate right now.</p>' +
    '<div class="row" style="margin-bottom:8px">' +
      '<button class="secondary" id="match">Match the open plate</button>' +
      (cands.length ? '<span class="muted">' + esc(cands[0].modelTitle) + ' \u2014 ' + via(cands[0].via) + '</span>' : '') +
    '</div>';
  const body = !list.length
    ? '<p class="muted">Nothing recent in ' + esc((S.exportDirs || ['Downloads, Desktop']).join(', ')) + '.</p>'
    : (cands.length ? modelPicker(cands, 'exports') : '<p class="muted">Match the open plate first to choose a model.</p>') +
      '<ul style="list-style:none;padding:0;margin:0">' + list.map(f =>
        '<li class="row" style="justify-content:space-between;border-top:1px solid var(--border);padding:6px 0">' +
        '<span class="grow"><span class="mono">' + esc(f.filename) + '</span><br><span class="muted">' + f.sizeMb + ' MB</span></span>' +
        '<span class="row">' +
        '<button data-file="' + esc(f.path) + '"' + (cands.length ? '' : ' disabled') + '>Push</button>' +
        '</span><div class="bar" style="flex-basis:100%"><i data-bar="' + esc(f.path) + '"></i></div></li>').join('') +
      '</ul>';
  el.innerHTML = head + body + '</div>';

  document.getElementById('match').onclick = () => orca.postMessage({ command:'project' });
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
                     promptAfterSlice: document.getElementById('prompt').checked });

orca.onMessage(msg => {
  if (msg.command === 'state') {
    S = Object.assign(S, msg.data);
    document.getElementById('mode').value = S.mode || 'ask';
    document.getElementById('prompt').checked = !!S.promptAfterSlice;
    renderSetup();
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
capability in the plugin list, or from the Actions Speed Dial. It shows the
slices waiting for a decision.</p>"""
)

CONFIG_HTML = (
    """<style>"""
    + BASE_CSS
    + """</style>
<h1>Print Vault</h1>
<p class="muted">Where sliced files are sent, and what happens after each slice.</p>
<label><span>Instance URL</span><input id="url" class="grow" placeholder="https://vault.example.com"></label>
<label><span>Push token</span><input id="token" class="grow" placeholder="pvpush_..."></label>
<label><span>After every slice</span>
  <select id="mode">
    <option value="ask">Queue it and ask me (run "Print Vault: review &amp; push")</option>
    <option value="auto">Push automatically when the model is certain</option>
    <option value="off">Do nothing</option>
  </select>
</label>
<label class="row"><input type="checkbox" id="prompt" style="width:auto">
  <span style="margin:0">Pop the question right after slicing (experimental)</span></label>
<label><span>Never queue a file larger than (MB)</span><input id="max" type="number" min="16" step="16"></label>
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
            orca.register_capability(PrintVaultReview)


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
        if not args.file:
            if args.save:
                return 0
            parser.error("a file to push is required")
        path = args.file
        if not os.path.exists(path):
            log(f"no such file: {path}")
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
