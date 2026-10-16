import { useEffect, useMemo } from "react";
import type { AppState } from "../../core/state/app/state";
import { useOptionalAppSelector } from "./context";

/**
 * The time the pointer or keyboard cursor is at on one chart of a layout tab,
 * which the tab's other charts show at the same moment: the last instant the
 * cursor covers, so a chart reads its data as of then. It is held per tab, in
 * memory only: a cursor moves on every pointer event, and the app store would
 * re-run every pane's selectors on each one.
 */
interface TabCursor {
  time: number;
  /** The chart the cursor is on; it never follows its own time back. */
  sourceId: string;
}

const cursors = new Map<string, TabCursor>();
const listeners = new Set<() => void>();

function setTabCursorTime(tabKey: string, sourceId: string | null, time: number | null): void {
  const current = cursors.get(tabKey);
  if (time === null) {
    // Only the chart the cursor is on can take it away: a chart clearing a
    // cursor it no longer holds must not clear another chart's. A null source
    // clears whichever chart holds it.
    if (!current || (sourceId !== null && current.sourceId !== sourceId)) return;
    cursors.delete(tabKey);
  } else {
    if (sourceId === null || (current?.sourceId === sourceId && current.time === time)) return;
    cursors.set(tabKey, { time, sourceId });
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A chart's handle on the cursor its layout tab shares. */
export interface TabCursorLink {
  /** Calls `listener` whenever a tab's cursor moves. */
  subscribe(listener: () => void): () => void;
  /** Where another chart's cursor is in this tab: null when none is, or the cursor is this chart's own. */
  time(): number | null;
  /** Whether this chart's cursor is the tab's. */
  held(): boolean;
  /** Reports this chart's cursor, or null when it leaves. */
  publish(time: number | null): void;
  /** Clears the tab's cursor, whichever chart holds it. */
  clear(): void;
}

/** A layout tab is named by its id; older saved tabs have none, and go by position. */
const selectTabKey = (state: AppState): string => {
  const { layouts, activeLayoutIndex } = state.config;
  return layouts[activeLayoutIndex]?.id ?? `index:${activeLayoutIndex}`;
};

/**
 * Shares a chart's cursor time with the other charts in its layout tab.
 * `sourceId` names the chart, unique in the tab: two charts in one pane each
 * have their own, so either follows the other. Reading the handle does not
 * re-render anything when the cursor moves: what draws the cursor
 * subscribes, so a pointer move on one chart re-renders the other charts and
 * nothing around them. A null `sourceId`, or no app around it (a test, a
 * screenshot), shares nothing.
 */
export function useTabCursorLink(sourceId: string | null): TabCursorLink | undefined {
  const tabKey = useOptionalAppSelector<string | null>(selectTabKey, null);
  const link = useMemo<TabCursorLink | undefined>(() => tabKey === null || sourceId === null ? undefined : {
    subscribe,
    time: () => {
      const cursor = cursors.get(tabKey);
      return cursor && cursor.sourceId !== sourceId ? cursor.time : null;
    },
    held: () => cursors.get(tabKey)?.sourceId === sourceId,
    publish: (time) => setTabCursorTime(tabKey, sourceId, time !== null && Number.isFinite(time) ? time : null),
    clear: () => setTabCursorTime(tabKey, null, null),
  }, [sourceId, tabKey]);
  // A chart closed or switched away from under the cursor takes its cursor with it.
  useEffect(() => () => link?.publish(null), [link]);
  return link;
}
