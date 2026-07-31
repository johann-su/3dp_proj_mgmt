#!/usr/bin/env python3
"""Push a freshly sliced file from OrcaSlicer back into Print Vault.

Paste into OrcaSlicer / Bambu Studio / PrusaSlicer under
  Print Settings -> Others -> Post-processing Scripts

    python3 /path/to/slice-push.py --url "https://vault.example.com/api/models/<model-id>/slice-push" --token "pvpush_..." ;

The model page's "Push from slicer" dialog prints that line with the URL and a
freshly minted token already filled in.

The slicer appends the path of the file it just produced as the final
argument, and post-processing runs on the *temporary* G-code before it is
exported to its final destination -- so what arrives here is normally a
`.gcode`, not a project file. `SLIC3R_PP_OUTPUT_NAME` holds the name the user
chose, which is what we send along so the catalogue shows something readable
instead of a temp name.

Deliberately stdlib-only (slicers ship no Python environment of their own) and
deliberately never fatal: a push failure must not break the user's slice, so
every error path still exits 0. Pass --strict while setting things up to make
failures loud instead.
"""

import argparse
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# Extensions the ingest endpoint accepts. A slicer configured to export
# something else is a misconfiguration worth reporting, not worth uploading.
ALLOWED = (".3mf", ".gcode")

RETRIES = 3
TIMEOUT_SECONDS = 120


def log(message):
    # Slicers surface stderr from a failing post-processing script; keeping
    # everything on stderr also guarantees we never write to stdout, which
    # PrusaSlicer-family slicers read back as a replacement output path.
    print(f"[slice-push] {message}", file=sys.stderr)


def output_name(path):
    """The name to store the file under, preferring the slicer's own."""
    chosen = os.environ.get("SLIC3R_PP_OUTPUT_NAME") or ""
    name = os.path.basename(chosen.strip()) or os.path.basename(path)
    # The temp file and the final output can disagree on extension (Bambu-style
    # setups name the export .gcode.3mf); the bytes we hold are what matters.
    src_ext = os.path.splitext(path)[1].lower()
    if src_ext and not name.lower().endswith(src_ext):
        name = f"{os.path.splitext(name)[0]}{src_ext}"
    return name


def push(url, token, path, name):
    with open(path, "rb") as handle:
        body = handle.read()

    target = f"{url}?filename={urllib.parse.quote(name)}"
    request = urllib.request.Request(
        target,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/octet-stream",
            "Content-Length": str(len(body)),
            "User-Agent": "print-vault-slice-push/1.0",
        },
    )

    last_error = None
    for attempt in range(1, RETRIES + 1):
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
                return response.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as err:
            detail = err.read().decode("utf-8", "replace").strip()
            # 4xx is our mistake (revoked token, wrong model, bad file) and
            # will not fix itself -- retrying only delays the slice.
            if 400 <= err.code < 500:
                raise RuntimeError(f"HTTP {err.code}: {detail or err.reason}") from err
            last_error = RuntimeError(f"HTTP {err.code}: {detail or err.reason}")
        except (urllib.error.URLError, OSError) as err:
            last_error = RuntimeError(str(err))

        if attempt < RETRIES:
            time.sleep(2 ** (attempt - 1))

    raise last_error


def main():
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument(
        "--url",
        default=os.environ.get("PRINT_VAULT_PUSH_URL"),
        help="the model's slice-push endpoint (or $PRINT_VAULT_PUSH_URL)",
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("PRINT_VAULT_PUSH_TOKEN"),
        help="a push token for that model (or $PRINT_VAULT_PUSH_TOKEN)",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="exit non-zero on failure (for testing the setup)",
    )
    # The slicer appends the exported path itself; anything it does not
    # recognise is passed through untouched, so parse loosely.
    args, extra = parser.parse_known_args()

    fail = (lambda message: (log(message), sys.exit(1 if args.strict else 0)))

    if not args.url or not args.token:
        return fail("no --url/--token (or PRINT_VAULT_PUSH_URL/_TOKEN) configured")

    if not extra:
        return fail("no file path given -- the slicer appends it as the last argument")
    path = extra[-1]

    if not os.path.isfile(path):
        return fail(f"no such file: {path}")

    name = output_name(path)
    if not name.lower().endswith(ALLOWED):
        return fail(f"{name}: only {' and '.join(ALLOWED)} can be pushed")

    try:
        push(args.url, args.token, path, name)
    except Exception as err:  # noqa: BLE001 - never break the slice
        return fail(f"push failed for {name}: {err}")

    log(f"pushed {name} ({os.path.getsize(path)} bytes)")


if __name__ == "__main__":
    main()
