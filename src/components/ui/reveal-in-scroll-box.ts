import type { BoxRenderable, ScrollBoxRenderable } from "../../ui";

export interface RevealOptions {
  /**
   * Where the top of a node that has to move lands, as a fraction of the
   * viewport from its top: reading on from a passage (the line being heard, a
   * find's match) wants it high with what follows below, where the least
   * distance would leave it on the bottom edge. A node already in view stays.
   */
  anchor?: number;
}

/**
 * Scrolls the least distance that brings `node` inside `scrollBox`'s viewport,
 * so the control the keyboard just moved to is on screen. The desktop measures
 * pixel rects; the terminal compares absolute cell rows with the viewport's.
 */
export function revealInScrollBox(scrollBox: ScrollBoxRenderable | null, node: BoxRenderable | null, options: RevealOptions = {}): void {
  if (!scrollBox || !node) return;
  const anchor = options.anchor === undefined ? null : Math.max(0, Math.min(1, options.anchor));
  const boxRect = scrollBox.getBoundingClientRect?.();
  const nodeRect = node.getBoundingClientRect?.();
  if (boxRect && nodeRect && scrollBox.scrollToPixels && typeof scrollBox.scrollTopPx === "number" && scrollBox.viewportPx) {
    const top = scrollBox.scrollTopPx + nodeRect.y - boxRect.y;
    const bottom = top + nodeRect.height;
    const viewport = scrollBox.viewportPx.height;
    const outside = top < scrollBox.scrollTopPx || bottom > scrollBox.scrollTopPx + viewport;
    if (anchor !== null) {
      if (outside) scrollBox.scrollToPixels(Math.max(0, top - Math.floor(viewport * anchor)));
    } else if (top < scrollBox.scrollTopPx) scrollBox.scrollToPixels(Math.max(0, top));
    else if (bottom > scrollBox.scrollTopPx + viewport) scrollBox.scrollToPixels(Math.max(0, Math.min(top, bottom - viewport)));
    return;
  }
  const viewport = scrollBox.viewport as { y?: unknown; height: number } | undefined;
  if (typeof node.y !== "number" || typeof viewport?.y !== "number" || viewport.height <= 0) return;
  const offset = node.y - viewport.y;
  const height = Math.max(1, node.height ?? 1);
  if (anchor !== null) {
    if (offset < 0 || offset + height > viewport.height) {
      scrollBox.scrollTo(Math.max(0, scrollBox.scrollTop + offset - Math.floor(viewport.height * anchor)));
    }
  } else if (offset < 0) scrollBox.scrollTo(Math.max(0, scrollBox.scrollTop + offset));
  else if (offset + height > viewport.height) {
    scrollBox.scrollTo(Math.max(0, scrollBox.scrollTop + Math.min(offset, offset + height - viewport.height)));
  }
}

/** Runs once the host has laid out the change that moved the keyboard. */
export function afterLayout(callback: () => void): () => void {
  const timer = setTimeout(callback, 0);
  return () => clearTimeout(timer);
}
