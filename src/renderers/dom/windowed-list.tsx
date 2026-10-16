/** @jsxImportSource react */
import { useCallback, useLayoutEffect, useRef } from "react";
import { observeElementRect, observeElementOffset, elementScroll } from "@tanstack/react-virtual";
import type { WindowedListProps } from "../../components/ui/windowed-list";
import type { ScrollBoxRenderable } from "../../ui/host";
import { STICKY_BOTTOM_THRESHOLD_PX } from "../../ui/sticky-scroll";
import { ScrollBox } from "../../ui";
import { useWindowedRows } from "./windowed-rows";

/** Uses the table's windowing engine, with measured rows and end anchoring. */
export function WebWindowedList({ itemKeys, renderItem, scrollRef, estimateSize = 64, overscan = 8, onScrollActivity, onPinChange, onPointerMove, role }: WindowedListProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  // On a hidden initial mount, rows can be measured on reveal before the
  // viewport observer runs. Keep the initial pin until that first real rect.
  const resizingViewport = useRef(true);
  const syncOffset = useRef<((offset: number, scrolling: boolean) => void) | null>(null);
  const onPinRef = useRef(onPinChange);
  onPinRef.current = onPinChange;
  const reportPin = useCallback((pinned: boolean) => {
    if (pinnedRef.current === pinned) return;
    pinnedRef.current = pinned;
    onPinRef.current?.(pinned);
  }, []);
  const getItemKey = useCallback((index: number) => itemKeys[index]!, [itemKeys]);
  const { list, rows } = useWindowedRows(contentRef, {
    count: itemKeys.length,
    getItemKey,
    getScrollElement: () => contentRef.current?.parentElement ?? null,
    estimateSize: () => estimateSize,
    // Images can end at fractional pixels. Rounding rows accumulates gaps or
    // overlaps, and a remounted row may have a different wrapping width.
    measureElement: (node, entry, instance) => {
      // display:none reports zero for every row. Those are not new message
      // heights: retain the measured history until its tab is visible again.
      if (!instance.scrollElement?.clientHeight) return instance.measurementsCache[Number(node.dataset.index)]?.size ?? estimateSize;
      return entry?.borderBoxSize?.[0]?.blockSize ?? node.getBoundingClientRect().height;
    },
    overscan,
    // Start with the tail, never a first render of the entire channel. The
    // actual viewport and row sizes replace these estimates before paint.
    initialRect: { width: 0, height: 1 },
    initialOffset: () => itemKeys.length * estimateSize,
    anchorTo: "end",
    // A hidden scrollport reports no extent, which otherwise looks like its
    // end to the windowing engine when a message arrives in an inactive tab.
    followOnAppend: pinnedRef.current,
    scrollEndThreshold: STICKY_BOTTOM_THRESHOLD_PX,
    scrollToFn: (offset, options, instance) => {
      // Grow the scroll extent before scrolling to it. Otherwise the browser
      // clamps a size correction to the old bottom, losing the last wrapped line.
      if (contentRef.current) contentRef.current.style.height = `${instance.getTotalSize()}px`;
      elementScroll(offset, options, instance);
      // Measurements can arrive before the browser's scroll event. Report the
      // applied position now so they cannot correct against the previous jump.
      if (instance.scrollElement && instance.scrollElement.clientHeight > 0) syncOffset.current?.(instance.scrollElement.scrollTop, false);
    },
    observeElementOffset: (instance, callback) => {
      syncOffset.current = callback;
      const dispose = observeElementOffset(instance, (offset, scrolling) => {
        if (instance.scrollElement?.clientHeight) callback(offset, scrolling);
      });
      return () => { syncOffset.current = null; dispose?.(); };
    },
    observeElementRect: (instance, callback) => {
      let height: number | undefined;
      let hidden = false;
      return observeElementRect(instance, (rect) => {
        if (rect.height === 0) { hidden = true; return; }
        // Width belongs to CSS. A live horizontal resize need not render React.
        if (height === rect.height && !hidden) return;
        const restore = hidden;
        hidden = false;
        height = rect.height;
        const follow = pinnedRef.current;
        const offset = instance.scrollOffset;
        resizingViewport.current = true;
        callback({ width: 0, height: rect.height });
        if (follow) instance.scrollToEnd();
        else if (restore && offset !== null) instance.scrollToOffset(offset);
        resizingViewport.current = false;
      });
    },
    onChange: (instance) => {
      if (resizingViewport.current || !instance.scrollElement?.clientHeight) return;
      reportPin(instance.isAtEnd(STICKY_BOTTOM_THRESHOLD_PX));
    },
  });
  // Preserve the top of the first visible row, including a partially read row.
  // Measuring overscan above it must adjust even during an upward wheel gesture.
  list.shouldAdjustScrollPositionOnItemSizeChange = (row, _delta, instance) => row.end <= (instance.scrollOffset ?? 0);
  const keysRef = useRef(itemKeys);
  keysRef.current = itemKeys;
  const restoreFrame = useRef<number | null>(null);
  const cancelRestore = useCallback(() => {
    if (restoreFrame.current !== null) cancelAnimationFrame(restoreFrame.current);
    restoreFrame.current = null;
  }, []);
  const handleScrollActivity = useCallback<NonNullable<WindowedListProps["onScrollActivity"]>>((event) => {
    if (event?.scroll) cancelRestore();
    onScrollActivity?.(event);
  }, [cancelRestore, onScrollActivity]);
  const setScrollRef = useCallback((handle: ScrollBoxRenderable | null) => {
    if (handle) {
      handle.scrollToEnd = () => {
        cancelRestore();
        pinnedRef.current = true;
        list.scrollToEnd();
        onPinRef.current?.(true);
      };
      handle.scrollToItem = (key, { align = "auto", offset = 0 } = {}) => {
        const index = keysRef.current.indexOf(key);
        if (index < 0) return false;
        cancelRestore();
        if (align === "center") {
          const row = list.elementsCache.get(key)?.getBoundingClientRect();
          const view = list.scrollElement?.getBoundingClientRect();
          // A link to an already visible row marks it without moving the reader.
          if (row && view && view.height > 0 && row.top >= view.top && row.bottom <= view.bottom) return true;
        }
        list.scrollToIndex(index, { align });
        // Selection calls this even when the row is already in view. A no-op
        // must not unpin a reader at the bottom before the composer resizes.
        if (list.scrollElement?.clientHeight) reportPin(list.isAtEnd(STICKY_BOTTOM_THRESHOLD_PX));
        if (align === "start") {
          // The target must be mounted and measured before restoring a partial
          // row at the viewport's top. Cancel on disposal or a subsequent jump.
          restoreFrame.current = requestAnimationFrame(() => {
            restoreFrame.current = requestAnimationFrame(() => {
              restoreFrame.current = null;
              const row = list.elementsCache.get(key);
              const scroller = list.scrollElement;
              if (row && scroller) list.scrollToOffset(scroller.scrollTop + row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset);
            });
          });
        }
        return true;
      };
    }
    scrollRef.current = handle;
  }, [cancelRestore, list, reportPin, scrollRef]);
  useLayoutEffect(() => {
    list.scrollToEnd();
    return cancelRestore;
  }, [cancelRestore, list]);
  const setContent = useCallback((node: HTMLDivElement | null) => {
    contentRef.current = node;
  }, []);
  return <ScrollBox ref={setScrollRef} flexGrow={1} scrollY focusable={false}
    data-gloom-role={role} onMouseScroll={handleScrollActivity} onMouseMove={onPointerMove}
    style={{ minHeight: 0, display: "block", overflowAnchor: "none" }}>
    <div ref={setContent} style={{ position: "relative", width: "100%", height: list.getTotalSize() }}>
      {rows.map((row) => <div key={row.key} data-index={row.index} ref={list.measureElement}
        style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${row.start}px)` }}>
        {renderItem(row.index)}
      </div>)}
    </div>
  </ScrollBox>;
}
