import { flushSync } from "react-dom";
import { WEB_CELL_HEIGHT, WEB_CELL_WIDTH } from "../../../theme/font-scale";
import { isLiveResizing } from "../../../ui/live-resize";

/**
 * The element's border box in cells each time the browser lays it out at a new
 * size, from a ResizeObserver: after layout, before paint. The first call
 * comes with the size it has once the commit that observes it has laid out.
 * What the listener renders renders there and then, so a chart that fills
 * its box when it opens draws its first frame at that size, not at its cells
 * and then again.
 */
export function observeCellSize(element: HTMLElement, listener: (size: { width: number; height: number }) => void): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  const observer = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1];
    if (!entry) return;
    const box = entry.borderBoxSize?.[0];
    const width = box ? box.inlineSize : entry.contentRect.width;
    const height = box ? box.blockSize : entry.contentRect.height;
    const size = { width: width / WEB_CELL_WIDTH, height: height / WEB_CELL_HEIGHT };
    // Measured cells only store a pending size during a live resize. Their
    // next catch-up owns the commit, so there is nothing to flush per plot.
    if (isLiveResizing()) listener(size);
    else flushSync(() => listener(size));
  });
  observer.observe(element);
  let observing = true;
  // Once the commit that observes it has laid out (a fill set by a parent's
  // effect included), before the next frame: a chart opened at a fraction
  // of a cell past its cells draws its first frame at that size.
  queueMicrotask(() => {
    if (!observing || !element.isConnected) return;
    const rect = element.getBoundingClientRect();
    flushSync(() => listener({ width: rect.width / WEB_CELL_WIDTH, height: rect.height / WEB_CELL_HEIGHT }));
  });
  return () => {
    observing = false;
    observer.disconnect();
  };
}
