import { useCallback, useRef } from "react";
import { useAppDispatch, usePaneInstance } from "../../../state/app/context";
import type { DataTableProps, DataTableVisibleRange } from "./types";
import { resolveDataTableVisibleRange } from "./visible-range";

/** Focuses the pane that owns the table, as every click inside it does. */
export function useFocusOwningPane(): () => void {
  const dispatch = useAppDispatch();
  const paneInstanceId = usePaneInstance()?.instanceId ?? null;
  return useCallback(() => {
    if (!paneInstanceId) return;
    dispatch({ type: "FOCUS_PANE", paneId: paneInstanceId });
  }, [dispatch, paneInstanceId]);
}

/**
 * Reports the rows in view through `onVisibleRangeChange`, once per change of
 * the range or of `visibleRangeKey`. Each renderer measures its own scroll
 * offset and viewport, in pixels or cells, and passes the row size to match.
 */
export function useVisibleRangeEmitter({
  itemCount,
  visibleRangeKey,
  visibleRangeBuffer,
  onVisibleRangeChange,
}: Pick<DataTableProps<unknown>, "visibleRangeKey" | "visibleRangeBuffer" | "onVisibleRangeChange"> & {
  itemCount: number;
}) {
  const lastVisibleRangeRef = useRef<{
    key: string | number | undefined;
    range: DataTableVisibleRange;
  } | null>(null);
  return useCallback((measure: { rowSize: number; scrollOffset: number; viewportSize: number }) => {
    if (!onVisibleRangeChange) return;
    const range = resolveDataTableVisibleRange({ ...measure, itemCount, buffer: visibleRangeBuffer });
    const previous = lastVisibleRangeRef.current;
    if (
      previous !== null
      && previous.key === visibleRangeKey
      && previous.range.start === range.start
      && previous.range.end === range.end
    ) return;
    lastVisibleRangeRef.current = { key: visibleRangeKey, range };
    onVisibleRangeChange(range);
  }, [itemCount, onVisibleRangeChange, visibleRangeBuffer, visibleRangeKey]);
}
