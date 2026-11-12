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
 * to one of these could not be seen: Tab passes them by. The bar is judged
 * along its middle line, where the title reads: the terminal's one row (the
 * frame's top line, title in it), the desktop's taller bar whatever line
 * sits over its top (a divider, a window's border). A window over the body,
 * or over no more than the top edge of the bar, hides nothing that says
 * focus.
 *
 * `headerRows` is the bar's height in the layout's units: 1 on the terminal,
 * the chrome row on the desktop (`paneHeaderRows`).
 */
export function resolveTitleCoveredPaneIds(
  docked: ReadonlyArray<{ paneId: string; rect: LayoutBounds }>,
  floating: readonly LayoutBounds[],
  { headerRows = 1 }: { headerRows?: number } = {},
): Set<string> {
  const covered = new Set<string>();
  if (floating.length === 0) return covered;
  for (const { paneId, rect } of docked) {
    if (rect.width <= 0) continue;
    const titleLine = rect.y + Math.min(headerRows, rect.height) / 2;
    const spans = floating
      .filter((window) => titleLine >= window.y && titleLine < window.y + window.height)
      .map((window) => [Math.max(rect.x, window.x), Math.min(rect.x + rect.width, window.x + window.width)] as const)
      .filter(([start, end]) => end > start)
      .toSorted((left, right) => left[0] - right[0]);
    let hidden = 0;
    let reach = rect.x;
    for (const [start, end] of spans) {
      if (end <= reach) continue;
      hidden += end - Math.max(start, reach);
      reach = end;
    }
    if (hidden * 2 >= rect.width) covered.add(paneId);
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
