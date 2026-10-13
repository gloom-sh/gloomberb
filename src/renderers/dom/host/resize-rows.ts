import { isLiveResizing, onLiveResizeEnd, onLiveResizeStart } from "../../../ui/live-resize";

/** Set on a row that keeps its width through a live resize; styles.css applies the width. */
export const RESIZE_HELD_ATTRIBUTE = "data-gloom-resize-held";
const HELD_WIDTH_PROPERTY = "--gloom-resize-held-width";
/** Rows this far past the view still follow, as a share of its height: more than a frame of movement brings in. */
const NEAR_VIEW_SHARE = 0.25;

export interface ResizeRows {
  /** After layout: rows that moved near the view follow the resize again from the next frame. */
  update(): void;
  dispose(): void;
}

/** Index of the first child whose bottom is below `y` (client px). Children stack in order, so their bottoms only grow. */
function firstChildEndingBelow(element: Element, y: number): number {
  const children = element.children;
  let low = 0;
  let high = children.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (children[middle]!.getBoundingClientRect().bottom > y) high = middle;
    else low = middle + 1;
  }
  return low;
}

/**
 * Rows of a long scroller that wrap their text to its width, while the pointer
 * resizes a pane: the rows in and near the view follow the new width on every
 * frame, the rest keep the width they had and take the new one when it lets
 * go. Laying out every row of a long transcript on every frame would cost the
 * frames the resize follows in, for rows nobody sees until it ends.
 *
 * A held row that comes near the view while the resize goes on (rows above
 * re-wrapping, a taller viewport) follows again from the next frame, before
 * it can be seen. Its width is held in CSS, so the row's own renders keep it.
 */
export function attachResizeRows(element: HTMLElement): ResizeRows {
  const held = new Set<HTMLElement>();
  const due = new Set<HTMLElement>();
  let frame: number | null = null;

  const nearView = () => {
    const rect = element.getBoundingClientRect();
    const margin = rect.height * NEAR_VIEW_SHARE;
    return { top: rect.top - margin, bottom: rect.bottom + margin };
  };

  const release = (row: HTMLElement) => {
    row.removeAttribute(RESIZE_HELD_ATTRIBUTE);
    row.style.removeProperty(HELD_WIDTH_PROPERTY);
    held.delete(row);
  };

  const hold = () => {
    const { top, bottom } = nearView();
    // Every width is read before any is set: a write between two reads would lay the list out again.
    const widths: Array<[HTMLElement, number]> = [];
    for (const child of Array.from(element.children) as HTMLElement[]) {
      if (held.has(child)) continue;
      const rect = child.getBoundingClientRect();
      if (rect.bottom > top && rect.top < bottom) continue;
      widths.push([child, rect.width]);
    }
    for (const [row, width] of widths) {
      row.style.setProperty(HELD_WIDTH_PROPERTY, `${width}px`);
      row.setAttribute(RESIZE_HELD_ATTRIBUTE, "");
      held.add(row);
    }
  };

  const releaseAll = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    due.clear();
    for (const row of Array.from(held)) release(row);
  };

  const update = () => {
    if (held.size === 0) return;
    const { top, bottom } = nearView();
    const children = element.children;
    for (let index = firstChildEndingBelow(element, top); index < children.length; index += 1) {
      const child = children[index] as HTMLElement;
      if (child.getBoundingClientRect().top >= bottom) break;
      if (held.has(child)) due.add(child);
    }
    if (due.size === 0 || frame !== null) return;
    // Not in this frame: a row that took its width now would resize again
    // inside the ResizeObserver delivery that is reading it.
    frame = requestAnimationFrame(() => {
      frame = null;
      for (const row of due) release(row);
      due.clear();
    });
  };

  const stopStart = onLiveResizeStart(hold);
  const stopEnd = onLiveResizeEnd(releaseAll);
  if (isLiveResizing()) hold();

  return {
    update,
    dispose() {
      stopStart();
      stopEnd();
      releaseAll();
    },
  };
}
