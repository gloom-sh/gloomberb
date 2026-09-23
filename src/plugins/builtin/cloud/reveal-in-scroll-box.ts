import type { BoxRenderable, ScrollBoxRenderable } from "../../../ui";

/**
 * Scrolls the least distance that brings `node` inside `scrollBox`'s viewport,
 * so the control the keyboard just moved to is on screen. The desktop measures
 * pixel rects; the terminal compares absolute cell rows with the viewport's.
 */
export function revealInScrollBox(scrollBox: ScrollBoxRenderable | null, node: BoxRenderable | null): void {
  if (!scrollBox || !node) return;
  const boxRect = scrollBox.getBoundingClientRect?.();
  const nodeRect = node.getBoundingClientRect?.();
  if (boxRect && nodeRect && scrollBox.scrollToPixels && typeof scrollBox.scrollTopPx === "number" && scrollBox.viewportPx) {
    const top = scrollBox.scrollTopPx + nodeRect.y - boxRect.y;
    const bottom = top + nodeRect.height;
    const viewport = scrollBox.viewportPx.height;
    if (top < scrollBox.scrollTopPx) scrollBox.scrollToPixels(Math.max(0, top));
    else if (bottom > scrollBox.scrollTopPx + viewport) scrollBox.scrollToPixels(Math.max(0, Math.min(top, bottom - viewport)));
    return;
  }
  const viewport = scrollBox.viewport as { y?: unknown; height: number } | undefined;
  if (typeof node.y !== "number" || typeof viewport?.y !== "number" || viewport.height <= 0) return;
  const offset = node.y - viewport.y;
  const height = Math.max(1, node.height ?? 1);
  if (offset < 0) scrollBox.scrollTo(Math.max(0, scrollBox.scrollTop + offset));
  else if (offset + height > viewport.height) {
    scrollBox.scrollTo(Math.max(0, scrollBox.scrollTop + Math.min(offset, offset + height - viewport.height)));
  }
}

/** Runs once the host has laid out the change that moved the keyboard. */
export function afterLayout(callback: () => void): () => void {
  const timer = setTimeout(callback, 0);
  return () => clearTimeout(timer);
}
