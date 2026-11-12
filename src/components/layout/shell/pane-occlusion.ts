import type { LayoutBounds } from "../../../layout/pane-manager";

export interface OcclusionPane {
  paneId: string;
  rect: LayoutBounds;
  /** Floating panes stack by z-index, then by render order. Docked panes sit below all of them. */
  zIndex: number | null;
  order: number;
}

/**
 * Panes whose every cell is covered by panes stacked above them.
 *
 * The terminal renderer is immediate-mode: it redraws every visible
 * renderable each frame before diffing, so a pane buried under floating
 * windows still costs its full draw on every keypress. Marking it invisible
 * skips the draw while its React tree, state, and subscriptions stay
 * mounted. Coverage is exact, so a pane hidden by the union of two windows
 * counts too, not only one wholly inside another.
 */
export function resolveOccludedPaneIds(
  panes: readonly OcclusionPane[],
  bounds: { width: number; height: number },
): Set<string> {
  const occluded = new Set<string>();
  const width = Math.max(0, Math.floor(bounds.width));
  const height = Math.max(0, Math.floor(bounds.height));
  if (width === 0 || height === 0 || panes.length < 2) return occluded;

  const stacked = [...panes].sort((left, right) => {
    const leftZ = left.zIndex ?? Number.NEGATIVE_INFINITY;
    const rightZ = right.zIndex ?? Number.NEGATIVE_INFINITY;
    if (leftZ !== rightZ) return rightZ - leftZ;
    return right.order - left.order;
  });

  const covered = new Uint8Array(width * height);
  for (const pane of stacked) {
    const x0 = Math.max(0, Math.floor(pane.rect.x));
    const y0 = Math.max(0, Math.floor(pane.rect.y));
    const x1 = Math.min(width, Math.ceil(pane.rect.x + pane.rect.width));
    const y1 = Math.min(height, Math.ceil(pane.rect.y + pane.rect.height));
    if (x1 <= x0 || y1 <= y0) continue;
    let hidden = true;
    for (let y = y0; y < y1 && hidden; y += 1) {
      const row = y * width;
      for (let x = x0; x < x1; x += 1) {
        if (covered[row + x] === 0) {
          hidden = false;
          break;
        }
      }
    }
    if (hidden) {
      occluded.add(pane.paneId);
      continue;
    }
    for (let y = y0; y < y1; y += 1) {
      covered.fill(1, y * width + x0, y * width + x1);
    }
  }
  return occluded;
}

/**
 * Docked panes whose title bar floating windows hide, half of it or more. A
 * focused pane shows its focus there (the frame, the title), so focus moved
 * to one of these could not be seen: Tab passes them by. Only the bar's first
 * row counts; a window over the body alone hides nothing that says focus.
 */
export function resolveTitleCoveredPaneIds(
  docked: ReadonlyArray<{ paneId: string; rect: LayoutBounds }>,
  floating: readonly LayoutBounds[],
): Set<string> {
  const covered = new Set<string>();
  if (floating.length === 0) return covered;
  for (const { paneId, rect } of docked) {
    const row = Math.floor(rect.y);
    const x0 = Math.floor(rect.x);
    const x1 = Math.ceil(rect.x + rect.width);
    if (x1 <= x0) continue;
    let hiddenCells = 0;
    for (let x = x0; x < x1; x += 1) {
      if (floating.some((window) => (
        x >= Math.floor(window.x) && x < Math.ceil(window.x + window.width)
        && row >= Math.floor(window.y) && row < Math.ceil(window.y + window.height)
      ))) hiddenCells += 1;
    }
    if (hiddenCells * 2 >= x1 - x0) covered.add(paneId);
  }
  return covered;
}

/**
 * Where focus belongs when the focused pane is hidden under floating panes,
 * as a docked pane is under a window that fills a narrow terminal: the
 * topmost pane that shows, so the keys go to what the reader sees. Null while
 * the focused pane shows, or nothing does.
 */
export function visibleFocusTarget(
  focusedPaneId: string | null,
  panes: readonly OcclusionPane[],
  occluded: ReadonlySet<string>,
): string | null {
  if (!focusedPaneId || !occluded.has(focusedPaneId)) return null;
  const shown = panes.filter((pane) => !occluded.has(pane.paneId));
  const top = shown.toSorted((left, right) => {
    const leftZ = left.zIndex ?? Number.NEGATIVE_INFINITY;
    const rightZ = right.zIndex ?? Number.NEGATIVE_INFINITY;
    return leftZ !== rightZ ? rightZ - leftZ : right.order - left.order;
  })[0];
  return top?.paneId ?? null;
}
