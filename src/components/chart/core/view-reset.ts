import { useCallback, useEffect, useRef } from "react";
import { useOptionalPaneInstanceId } from "../../../state/app/context";

/**
 * A pane's range control and its charts share one request: choosing the range
 * that is already selected sends the charts back to it, as `0` does on a chart
 * whose view was panned or zoomed. A chart answers for its own view, and a pane
 * that keeps a view of its own (a saved one, a loaded window) answers for that.
 */
type ViewReset = () => void;

const listeners = new Map<string, Set<ViewReset>>();
/** Charts outside a pane (a dialog, a test) share one scope. */
const NO_PANE = "";

function runViewResets(scope: string): void {
  for (const reset of [...listeners.get(scope) ?? []]) reset();
}

/**
 * Registers what happens in this pane when a range is chosen again. Keep it
 * idempotent and a no-op for a view that was never moved: the request also
 * arrives when the user presses the range that was already showing.
 */
export function useChartViewResetListener(reset: ViewReset, enabled = true): void {
  const scope = useOptionalPaneInstanceId() ?? NO_PANE;
  const latest = useRef(reset);
  latest.current = reset;
  useEffect(() => {
    if (!enabled) return;
    const run = () => latest.current();
    let set = listeners.get(scope);
    if (!set) listeners.set(scope, set = new Set());
    set.add(run);
    return () => {
      set.delete(run);
      if (set.size === 0 && listeners.get(scope) === set) listeners.delete(scope);
    };
  }, [enabled, scope]);
}

/** Sends this pane's charts back to the range they were given. */
export function useChartViewReset(): () => void {
  const scope = useOptionalPaneInstanceId() ?? NO_PANE;
  return useCallback(() => runViewResets(scope), [scope]);
}
