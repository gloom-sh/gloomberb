import { STICKY_BOTTOM_THRESHOLD_PX } from "../../../ui/sticky-scroll";
import { attachResizeRows } from "./resize-rows";

/** A shift under this, in px, is rounding in the layout, not content moving. */
const ANCHOR_TOLERANCE_PX = 0.5;

export interface StickyScroll {
  /** Takes in a scroll position set from outside, such as `scrollTo`. */
  sync(): void;
  dispose(): void;
}

interface Anchor {
  node: Element;
  /** Where the node's top sat below the scroller's top when last measured. */
  offset: number;
}

/**
 * The scrolling the terminal's ScrollBox does with `stickyScroll`, for a DOM
 * scroller, plus what a browser's own scroll anchoring does where it has none.
 *
 * While the reader is at the bottom, content that grows (a new row, a late
 * image, a row that wraps differently, a shorter viewport) keeps the bottom in
 * view. Away from the bottom, the first row in view stays where it is on screen
 * when anything above it changes: rows prepended by a history page, an edit or
 * a reaction above the viewport, a resize that re-wraps text. Neither rule
 * moves the view for a reader's own scrolling, which is read back from the
 * scroll position each time rather than from a flag that something else sets.
 *
 * Changes arrive from a ResizeObserver on the scroller and its children
 * (after layout, before paint) and a MutationObserver for rows added or removed.
 */
export function attachStickyScroll(
  element: HTMLElement,
  { startAtBottom, onPinChange }: {
    startAtBottom: boolean;
    /** The reader reached the bottom, or left it. */
    onPinChange?: (pinned: boolean) => void;
  },
): StickyScroll {
  let pinned = startAtBottom;
  let anchor: Anchor | null = null;
  let knownTop = element.scrollTop;
  const observed = new Set<Element>();
  const rows = attachResizeRows(element);

  const maxScrollTop = () => Math.max(0, element.scrollHeight - element.clientHeight);
  const atBottom = () => maxScrollTop() - element.scrollTop <= STICKY_BOTTOM_THRESHOLD_PX;
  const offsetOf = (node: Element) => node.getBoundingClientRect().top - element.getBoundingClientRect().top;

  /** The first child with any part below the scroller's top edge. */
  const pickAnchor = (): Anchor | null => {
    const top = element.getBoundingClientRect().top;
    for (const child of Array.from(element.children)) {
      const rect = child.getBoundingClientRect();
      if (rect.height > 0 && rect.bottom > top + 1) return { node: child, offset: rect.top - top };
    }
    return null;
  };

  const readPosition = () => {
    knownTop = element.scrollTop;
    const nowPinned = atBottom();
    // A pinned list keeps its bottom, not a row.
    anchor = nowPinned ? null : pickAnchor();
    if (nowPinned === pinned) return;
    pinned = nowPinned;
    onPinChange?.(pinned);
  };

  const settle = () => {
    // A scroll the browser has not announced yet is the reader's: take it as
    // it is instead of undoing it with a position from before.
    if (element.scrollTop !== knownTop) {
      readPosition();
      return;
    }
    if (pinned) {
      const bottom = maxScrollTop();
      if (element.scrollTop < bottom) element.scrollTop = bottom;
    } else if (anchor && anchor.node.parentElement === element) {
      const shift = offsetOf(anchor.node) - anchor.offset;
      if (Math.abs(shift) > ANCHOR_TOLERANCE_PX) element.scrollTop += shift;
    }
    readPosition();
  };

  // A change of width alone moves nothing: a row that wraps differently changes height too.
  const heights = new WeakMap<Element, number>();
  const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver((entries) => {
    let changed = false;
    for (const entry of entries) {
      const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
      if (heights.get(entry.target) === height) continue;
      heights.set(entry.target, height);
      changed = true;
    }
    if (!changed) return;
    settle();
    rows.update();
  });
  const observeChildren = () => {
    if (!resizeObserver) return;
    const current = new Set<Element>(Array.from(element.children));
    for (const child of observed) {
      if (current.has(child)) continue;
      resizeObserver.unobserve(child);
      observed.delete(child);
    }
    for (const child of current) {
      if (observed.has(child)) continue;
      resizeObserver.observe(child);
      observed.add(child);
    }
  };
  const mutationObserver = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => {
    observeChildren();
    settle();
  });

  resizeObserver?.observe(element);
  observeChildren();
  mutationObserver?.observe(element, { childList: true });
  // The browser also reports a scroll when only the scrollport changed size
  // (the position stayed, the bottom moved): that is not the reader leaving it.
  const onScroll = () => {
    if (element.scrollTop === knownTop) return;
    readPosition();
    rows.update();
  };
  element.addEventListener("scroll", onScroll, { passive: true });
  // Opens at the bottom of what is already there, or wherever it was left.
  if (startAtBottom) settle();
  else readPosition();

  return {
    sync: readPosition,
    dispose() {
      rows.dispose();
      element.removeEventListener("scroll", onScroll);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      observed.clear();
    },
  };
}
