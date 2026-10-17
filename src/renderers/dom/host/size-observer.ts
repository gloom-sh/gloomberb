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
 *
 * A box that is not displayed has no size to report: a research tab kept
 * mounted while another one shows sits under `display: none`, and the 0 by 0
 * the browser reports there would have its chart redraw for one pixel and
 * show that pixel stretched over the plot when the tab comes back (GLO-590).
 * It keeps the size it was last laid out at instead, so the tab comes back
 * with the bitmap it left with.
 */
export function observeCellSize(
  element: HTMLElement,
  listener: (size: { width: number; height: number }, change: { revealed: boolean }) => void,
): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  let hidden = false;
  const observer = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1];
    if (!entry) return;
    if (!isDisplayed(element)) {
      hidden = true;
      return;
    }
    // A size the box takes as it shows again was never painted: what draws
    // for it draws now, not after a resize's debounce (the pane's footer
    // differs from tab to tab, so a hidden tab often comes back resized).
    const change = { revealed: hidden };
    hidden = false;
    const box = entry.borderBoxSize?.[0];
    const width = box ? box.inlineSize : entry.contentRect.width;
    const height = box ? box.blockSize : entry.contentRect.height;
    const size = { width: width / WEB_CELL_WIDTH, height: height / WEB_CELL_HEIGHT };
    // Measured cells only store a pending size during a live resize. Their
    // next catch-up owns the commit, so there is nothing to flush per plot.
    if (isLiveResizing()) listener(size, change);
    else flushSync(() => listener(size, change));
  });
  observer.observe(element);
  let observing = true;
  // Once the commit that observes it has laid out (a fill set by a parent's
  // effect included), before the next frame: a chart opened at a fraction
  // of a cell past its cells draws its first frame at that size.
  queueMicrotask(() => {
    if (!observing || !element.isConnected) return;
    if (!isDisplayed(element)) {
      hidden = true;
      return;
    }
    const rect = element.getBoundingClientRect();
    flushSync(() => listener({ width: rect.width / WEB_CELL_WIDTH, height: rect.height / WEB_CELL_HEIGHT }, { revealed: false }));
  });
  return () => {
    observing = false;
    observer.disconnect();
  };
}

/** False under `display: none` (its own or an ancestor's): such a box has no layout box at all, not an empty one. */
function isDisplayed(element: HTMLElement): boolean {
  return element.getClientRects().length > 0;
}
