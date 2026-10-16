import { useLayoutEffect, useReducer, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { Virtualizer, type VirtualizerOptions } from "@tanstack/react-virtual";

/**
 * The shared windowing engine with a buffered React subscription. Size changes
 * update CSS positions directly; React only mounts rows when the viewport is
 * about to leave the existing overscan. In particular, wrapping during a pane
 * resize must not commit once per visible-range change.
 */
export function useWindowedRows(
  content: RefObject<HTMLDivElement | null>,
  options: VirtualizerOptions<HTMLElement, HTMLDivElement>,
) {
  const [, render] = useReducer((value: number) => value + 1, 0);
  const windowRef = useRef<{ start: number; end: number; count: number; firstKey: unknown } | null>(null);
  const needsWindow = (list: Virtualizer<HTMLElement, HTMLDivElement>) => {
    const mounted = windowRef.current;
    const visible = list.range;
    if (!mounted || mounted.count !== list.options.count || mounted.firstKey !== list.options.getItemKey(0)) return true;
    if (!visible) return false;
    const buffer = Math.floor(list.options.overscan / 2);
    return (mounted.start > 0 && visible.startIndex < mounted.start + buffer)
      || (mounted.end < list.options.count - 1 && visible.endIndex > mounted.end - buffer)
      // A much smaller viewport must also shed its old window. Keep hysteresis
      // for ordinary wrapping, without retaining an arbitrarily large old view.
      || visible.startIndex - mounted.start > list.options.overscan * 2
      || mounted.end - visible.endIndex > list.options.overscan * 2;
  };
  const positionRows = (list: Virtualizer<HTMLElement, HTMLDivElement>) => {
    const total = list.getTotalSize();
    if (content.current) content.current.style.height = `${total}px`;
    for (const [key, element] of list.elementsCache) {
      const row = list.measurementsCache[Number(element.dataset.index)];
      if (row?.key === key) element.style.transform = `translateY(${row.start}px)`;
    }
  };
  const resolved = {
    ...options,
    onChange: (list: Virtualizer<HTMLElement, HTMLDivElement>, sync: boolean) => {
      positionRows(list);
      if (needsWindow(list)) {
        if (sync) flushSync(render);
        else render();
      }
      options.onChange?.(list, sync);
    },
  };
  const [list] = useState(() => new Virtualizer(resolved));
  list.setOptions(resolved);
  const desired = list.getVirtualItems();
  if (needsWindow(list)) windowRef.current = {
    start: desired[0]?.index ?? 0,
    end: desired.at(-1)?.index ?? -1,
    count: options.count,
    firstKey: options.getItemKey?.(0),
  };
  const mounted = windowRef.current!;
  const rows = list.measurementsCache.slice(mounted.start, mounted.end + 1);
  useLayoutEffect(() => list._didMount(), [list]);
  useLayoutEffect(() => { list._willUpdate(); positionRows(list); });
  return { list, rows };
}
