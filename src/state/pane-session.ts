import {
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type SetStateAction,
} from "react";
import { useOptionalPaneInstanceId } from "./app/context";

/**
 * Memory a pane keeps for as long as the pane exists, rather than for as long
 * as it is mounted.
 *
 * Docking, floating, stacking or fullscreening a pane draws it in another
 * place in the tree, so its component mounts again. What it shows has to come
 * back on the first frame: a pane that reads it from component state, or has to
 * fetch it again, draws its empty state in between and loses the selection.
 * What the user chose and can save belongs in pane state (`usePluginPaneState`,
 * `usePaneSettingValue`); this holds what cannot be saved or must not be: a
 * live conversation with its answer still coming in, a transcript, a draft.
 * It is in memory only, so a relaunch starts without it, and a shared layout
 * never carries it.
 */

/**
 * How long a pane's memory outlives its last mounted view. A move between the
 * dock and a floating window mounts the new view in the commit that unmounts
 * the old one; a closed pane never mounts again, and its memory is released
 * after this.
 */
export const PANE_SESSION_GRACE_MS = 2_000;

interface SessionEntry {
  id: string;
  value: unknown;
  dispose: ((value: never) => void) | undefined;
  holders: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, SessionEntry>();

function scheduleRelease(entry: SessionEntry): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (entry.holders > 0 || sessions.get(entry.id) !== entry) return;
    sessions.delete(entry.id);
    entry.dispose?.(entry.value as never);
  }, PANE_SESSION_GRACE_MS);
}

/** Finds a pane's session or makes it. One a render makes and nothing mounts is released like any other. */
function acquire<T>(paneId: string, key: string, create: () => T, dispose: ((value: T) => void) | undefined): SessionEntry {
  const id = `${paneId}\u0000${key}`;
  const existing = sessions.get(id);
  if (existing) return existing;
  const entry: SessionEntry = { id, value: create(), dispose: dispose as SessionEntry["dispose"], holders: 0, timer: null };
  sessions.set(id, entry);
  scheduleRelease(entry);
  return entry;
}

/** Test hook: releases every pane's memory now, so one test's panes never start on another's. */
export function resetPaneSessionsForTests(): void {
  for (const entry of [...sessions.values()]) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    sessions.delete(entry.id);
    entry.dispose?.(entry.value as never);
  }
}

function useScopedPaneId(paneId?: string): string {
  const contextId = useOptionalPaneInstanceId();
  const scoped = paneId ?? contextId;
  if (!scoped) throw new Error("A pane session requires a pane id or PaneInstanceProvider");
  return scoped;
}

/**
 * An object that lives as long as the pane does: the same one in every view
 * the pane is drawn in, made by `create` the first time. `dispose` runs once
 * the pane has had no mounted view for the grace period (the pane was closed).
 * Read it during render; it never changes identity while the pane exists.
 */
export function usePaneSession<T>(
  key: string,
  create: () => T,
  dispose?: (value: T) => void,
  paneId?: string,
): T {
  const scopedPaneId = useScopedPaneId(paneId);
  const entry = useMemo(() => acquire(scopedPaneId, key, create, dispose), [scopedPaneId, key]);
  useEffect(() => {
    entry.holders += 1;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    return () => {
      entry.holders -= 1;
      if (entry.holders <= 0) scheduleRelease(entry);
    };
  }, [entry]);
  return entry.value as T;
}

interface StateBox<T> {
  value: T;
  listeners: Set<() => void>;
}

/**
 * `useState` for a selection or draft that cannot be saved with the pane: the
 * value is kept for the pane, so the view mounted after a dock change starts on
 * it. A setter held by the view it unmounted still lands, on the value the new
 * view reads. See `usePaneSession` for what belongs here and what belongs in
 * pane state.
 */
export function usePaneSessionState<T>(
  key: string,
  initial: T | (() => T),
  paneId?: string,
): [T, (value: SetStateAction<T>) => void] {
  const box = usePaneSession<StateBox<T>>(key, () => ({
    value: typeof initial === "function" ? (initial as () => T)() : initial,
    listeners: new Set(),
  }), undefined, paneId);
  const subscribe = useCallback((listener: () => void) => {
    box.listeners.add(listener);
    return () => {
      box.listeners.delete(listener);
    };
  }, [box]);
  const getSnapshot = useCallback(() => box.value, [box]);
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const setValue = useCallback((next: SetStateAction<T>) => {
    const resolved = typeof next === "function" ? (next as (previous: T) => T)(box.value) : next;
    if (Object.is(resolved, box.value)) return;
    box.value = resolved;
    for (const listener of [...box.listeners]) listener();
  }, [box]);
  return [value, setValue];
}
