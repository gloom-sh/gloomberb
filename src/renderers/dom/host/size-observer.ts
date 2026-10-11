import { WEB_CELL_HEIGHT, WEB_CELL_WIDTH } from "../../../theme/font-scale";
import { PANE_FILL_SELECTOR } from "../../../ui/pane-fill";

/**
 * The element's border box in cells each time the browser lays it out at a new
 * size, from a ResizeObserver: after layout, before paint. The first call
 * comes with the size it has when observed.
 */
export function observeCellSize(element: HTMLElement, listener: (size: { width: number; height: number }) => void): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  const observer = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1];
    if (!entry) return;
    const box = entry.borderBoxSize?.[0];
    const width = box ? box.inlineSize : entry.contentRect.width;
    const height = box ? box.blockSize : entry.contentRect.height;
    listener({ width: width / WEB_CELL_WIDTH, height: height / WEB_CELL_HEIGHT });
  });
  observer.observe(element);
  return () => observer.disconnect();
}

/** Whether styles.css sizes the element to its pane's content box. */
export function fillsPane(element: HTMLElement): boolean {
  return element.matches(PANE_FILL_SELECTOR);
}
