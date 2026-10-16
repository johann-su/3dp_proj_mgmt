"use client";

import { useLayoutEffect, useRef } from "react";
import {
  parseSnapshot,
  SNAPSHOT_PREFIX,
  snapshotKey,
  snapshotsToEvict,
  type ListSnapshot,
} from "@/lib/list-restore";

// Puts an endless-scroll list back the way the user left it when they return
// to it with Back/Forward (or reload): the pages they had loaded and their
// scroll offset. A fresh visit (a link, a new query) starts at the top as
// before. See src/lib/list-restore.ts for why the browser can't do this alone.
//
// "Return" is told apart from "fresh visit" per history entry: the first
// mount stamps an id into history.state, and Next's patched replaceState
// keeps it on that entry (and drops it from any new entry Next pushes). An
// entry that already carries an id is being revisited.
//
// Everything here is best-effort: storage may be full or disabled, and then
// the list simply loads fresh.

const ENTRY_FIELD = "__listRestoreId";
const INDEX_KEY = `${SNAPSHOT_PREFIX}index`;

function historyEntry(): { id: string; revisit: boolean } {
  const state = (window.history.state ?? {}) as Record<string, unknown>;
  const existing = state[ENTRY_FIELD];
  if (typeof existing === "string") return { id: existing, revisit: true };
  // Not crypto.randomUUID: it only exists in secure contexts, and a
  // self-hosted instance may be served over plain HTTP on the LAN.
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  window.history.replaceState({ ...state, [ENTRY_FIELD]: id }, "");
  return { id, revisit: false };
}

function readSnapshot<T>(key: string): ListSnapshot<T> | null {
  try {
    return parseSnapshot<T>(sessionStorage.getItem(key), Date.now());
  } catch {
    return null;
  }
}

function writeSnapshot<T>(key: string, snapshot: ListSnapshot<T>) {
  try {
    sessionStorage.setItem(key, JSON.stringify(snapshot));
    // A small index of save times keeps eviction from parsing every snapshot.
    let index: Record<string, number> = {};
    try {
      index = JSON.parse(sessionStorage.getItem(INDEX_KEY) ?? "{}") ?? {};
    } catch {}
    index[key] = snapshot.savedAt;
    for (const evict of snapshotsToEvict(
      Object.entries(index).map(([k, savedAt]) => ({ key: k, savedAt })),
    )) {
      sessionStorage.removeItem(evict);
      delete index[evict];
    }
    sessionStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // Quota exceeded or storage disabled — this visit just won't restore.
  }
}

// Scrolls to `y`, retrying while the page grows into it: on a reload or a
// streamed page the restored rows can render before the rest of the layout
// (fonts, the header, sibling content) has settled, and the browser clamps a
// jump past the current end. Gives up once reached, on any user scroll
// input, or after a couple of seconds — then calls `done`. Returns a cancel
// function (which doesn't call `done`).
function scrollWhenReachable(y: number, done: () => void): () => void {
  const reached = () => Math.abs(window.scrollY - y) < 2;
  window.scrollTo(0, y);
  if (reached()) {
    done();
    return () => {};
  }

  const observer = new ResizeObserver(() => {
    window.scrollTo(0, y);
    if (reached()) finish();
  });
  const timer = window.setTimeout(finish, 2000);
  const userInput = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
  function cancel() {
    observer.disconnect();
    window.clearTimeout(timer);
    for (const type of userInput) window.removeEventListener(type, finish);
  }
  function finish() {
    cancel();
    done();
  }
  observer.observe(document.body);
  for (const type of userInput) {
    window.addEventListener(type, finish, { passive: true });
  }
  return cancel;
}

export function useListRestore<T>({
  restoreKey,
  items,
  cursor,
  initialCount,
  restore,
}: {
  // Identifies the list (e.g. its query); undefined disables restoring.
  restoreKey: string | undefined;
  items: T[];
  cursor: string | null;
  // Length of the server-rendered first page.
  initialCount: number;
  // Replaces the list with the saved pages.
  restore: (items: T[], cursor: string | null) => void;
}) {
  // What the cleanup saves. A layout effect declared before the restore
  // effect, so on a (Strict Mode) effect replay it runs first and the restore
  // effect's seeding below wins.
  const latest = useRef({ items, cursor });
  useLayoutEffect(() => {
    latest.current = { items, cursor };
  }, [items, cursor]);

  // Read once at mount. The effect below must not re-run when a server
  // refresh hands the list new props — only a remount is a new visit.
  const mountArgs = useRef({ initialCount, restore });
  const pendingScroll = useRef<number | null>(null);

  // Layout effects so the saved pages render and the offset is applied
  // before the first paint (no flash of the top of the list), and so the
  // cleanup runs while the old page is being removed — before the next page
  // scrolls the window, which would otherwise be recorded as this list's
  // position.
  useLayoutEffect(() => {
    if (!restoreKey) return;
    const { id, revisit } = historyEntry();
    // This entry's scroll position is ours to restore. Left on "auto", the
    // browser re-applies its own (stale, clamped) record after the page
    // settles, undoing the restore. The mode is stored per history entry, so
    // other pages keep native restoration.
    window.history.scrollRestoration = "manual";
    const key = snapshotKey(restoreKey, id);
    let scrollY = window.scrollY;

    if (revisit) {
      const saved = readSnapshot<T>(key);
      // Only ever grow the list: a shorter snapshot (saved before the first
      // page grew) would hide items the server just rendered.
      if (saved && saved.items.length >= mountArgs.current.initialCount) {
        mountArgs.current.restore(saved.items, saved.cursor);
        pendingScroll.current = saved.scrollY;
        // Until the restored list renders, the cleanup below would save the
        // first page at offset 0 over the snapshot (Strict Mode runs it right
        // away in dev). Seed what it saves from the snapshot instead.
        latest.current = { items: saved.items, cursor: saved.cursor };
        scrollY = saved.scrollY;
      }
    }

    // Tracked from scroll events rather than read at unmount: by then the
    // document may already be shorter and the browser has clamped scrollY.
    // Next also scrolls the window to the top for the next page *before* this
    // list unmounts; by then the URL has changed, so ignore those events.
    const href = window.location.href;
    const onScroll = () => {
      if (window.location.href === href) scrollY = window.scrollY;
    };
    const save = () =>
      writeSnapshot(key, {
        items: latest.current.items,
        cursor: latest.current.cursor,
        scrollY,
        savedAt: Date.now(),
      });
    window.addEventListener("scroll", onScroll, { passive: true });
    // A full unload (reload, leaving the app) skips the cleanup.
    window.addEventListener("pagehide", save);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", save);
      save();
      // A pushed entry inherits the current one's mode, and by now Next has
      // pushed the next page's entry: hand it back to native restoration.
      window.history.scrollRestoration = "auto";
    };
  }, [restoreKey]);

  // Runs after the restored items have rendered, so the document is tall
  // enough to scroll to the saved offset.
  useLayoutEffect(() => {
    if (pendingScroll.current === null) return;
    // Cleared only once finished: a cancelled attempt (Strict Mode replays
    // this effect in dev) must start again on the re-run.
    return scrollWhenReachable(pendingScroll.current, () => {
      pendingScroll.current = null;
    });
  }, [items]);
}
