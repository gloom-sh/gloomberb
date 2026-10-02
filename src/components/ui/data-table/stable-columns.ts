import { useRef } from "react";
import type { DataTableColumn } from "./types";

/**
 * Panes often build their column list inline, so its identity changes on every
 * render even when nothing in it did. Row memoization keys on the derived
 * display columns, so a fresh array would re-render every visible row on each
 * keypress. Compares every own field of every column so a pane-specific field
 * that changes still gets through.
 */
function columnsEqual<C extends DataTableColumn>(
  previous: readonly C[],
  next: readonly C[],
): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    const left = previous[index] as Record<string, unknown>;
    const right = next[index] as Record<string, unknown>;
    if (left === right) continue;
    const leftKeys = Object.keys(left);
    if (leftKeys.length !== Object.keys(right).length) return false;
    for (const key of leftKeys) {
      if (!Object.is(left[key], right[key])) return false;
    }
  }
  return true;
}

export function useStableColumns<C extends DataTableColumn>(columns: readonly C[]): readonly C[] {
  const stable = useRef(columns);
  if (!columnsEqual(stable.current, columns)) stable.current = columns;
  return stable.current;
}
