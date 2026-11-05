import { useSyncExternalStore } from "react";
import type { AppPluginStateStorePort } from "../core/app-service-ports";
import { fnv1aHex } from "../utils/hash";
import { logFailure } from "../utils/log-failure";

/**
 * Which data warnings the user has already opened, so the footer's ⚠ stops
 * asking for attention (warning yellow) once it has been read. A warning is
 * remembered by its text: the same text in another pane, on another visit or
 * after a restart is still read, and any new or changed text is not.
 */

/** The most warnings remembered; the one opened longest ago is forgotten first. */
export const SEEN_PANE_NOTICE_LIMIT = 200;

const STATE_OWNER = "core.pane-notices";
const STATE_KEY = "seen";
const NOTICE_ID = /^[0-9a-f]{16}$/;

interface SeenNoticeStore {
  get(): readonly unknown[];
  set(ids: readonly string[]): void;
}

// Oldest first, so the newest are the ones kept when the list is cut.
let seen: string[] = [];
let store: SeenNoticeStore | null = null;
const listeners = new Set<() => void>();

/** A warning's id: two hashes of its trimmed text, 16 hex digits, so the stored set stays small and holds no text. */
function noticeId(notice: string): string {
  const text = notice.trim();
  return `${fnv1aHex(text)}${fnv1aHex(`${text.length}:${text}`)}`;
}

function settle(ids: readonly unknown[]): string[] {
  const unique = new Map<string, true>();
  for (const id of ids) {
    if (typeof id !== "string" || !NOTICE_ID.test(id)) continue;
    unique.delete(id);
    unique.set(id, true);
  }
  return [...unique.keys()].slice(-SEEN_PANE_NOTICE_LIMIT);
}

/** Stores the new order, and tells readers only when the set of warnings they see as opened changed. */
function commit(next: string[], persist = true): void {
  const before = new Set(seen);
  const changed = next.length !== before.size || next.some((id) => !before.has(id));
  seen = next;
  if (persist) {
    try {
      store?.set(seen);
    } catch (error) {
      logFailure("pane-notice-seen", "Saving seen data warnings failed")(error);
    }
  }
  if (changed) for (const listener of listeners) listener();
}

/** Loads the set from a store. Warnings opened before it was attached are kept. */
function configure(nextStore: SeenNoticeStore | null): void {
  store = nextStore;
  let saved: readonly unknown[] = [];
  let loaded = false;
  try {
    saved = nextStore?.get() ?? [];
    loaded = true;
  } catch (error) {
    logFailure("pane-notice-seen", "Loading seen data warnings failed")(error);
  }
  // What is stored is rewritten only to add warnings opened before the store
  // was attached, never after a failed read, which would replace it with nothing.
  const savedIds = new Set(settle(saved));
  commit(settle([...saved, ...seen]), loaded && seen.some((id) => !savedIds.has(id)));
}

/**
 * Keeps the set in the app's local state store (SQLite in the terminal and the
 * desktop app, browser storage on the web), never in config.json or synced
 * settings. Returns the detach.
 */
export function attachSeenPaneNotices(pluginState: Pick<AppPluginStateStorePort, "get" | "set">): () => void {
  configure({
    get: () => {
      const value = pluginState.get<unknown>(STATE_OWNER, STATE_KEY)?.value;
      return Array.isArray(value) ? value : [];
    },
    set: (ids) => pluginState.set(STATE_OWNER, STATE_KEY, ids),
  });
  return () => configure(null);
}

/** Whether every one of these warnings has been opened: false for none at all. */
export function arePaneNoticesSeen(notices: readonly string[]): boolean {
  if (notices.length === 0) return false;
  const known = new Set(seen);
  return notices.every((notice) => known.has(noticeId(notice)));
}

/** Records these warnings as opened. Opening again keeps them among the newest. */
export function markPaneNoticesSeen(notices: readonly string[]): void {
  if (notices.length === 0) return;
  const next = settle([...seen, ...notices.map(noticeId)]);
  if (next.length === seen.length && next.every((id, index) => id === seen[index])) return;
  commit(next);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether the user has opened every one of these warnings; follows the set as it changes. */
export function usePaneNoticesSeen(notices: readonly string[]): boolean {
  return useSyncExternalStore(subscribe, () => arePaneNoticesSeen(notices), () => false);
}

export function resetSeenPaneNoticesForTest(): void {
  seen = [];
  store = null;
  listeners.clear();
}
