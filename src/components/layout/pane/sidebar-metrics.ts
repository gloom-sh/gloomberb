/**
 * How wide a pane sidebar is and whether it is worth drawing.
 *
 * Kept apart from the component so a store that only needs the numbers does
 * not pull a React tree, and above all does not reach the `components` barrel,
 * which re-exports plugin modules and would drag them into a plain module's
 * import graph.
 */

const PANE_SIDEBAR_MIN_WIDTH = 18;
const PANE_SIDEBAR_MAX_WIDTH = 24;
const PANE_SIDEBAR_WIDTH_RATIO = 0.24;
const DESKTOP_PANE_SIDEBAR_MIN_WIDTH = 14;
const DESKTOP_PANE_SIDEBAR_MAX_WIDTH = 19;
const DESKTOP_PANE_SIDEBAR_WIDTH_RATIO = 0.192;
const PANE_SIDEBAR_BREAKPOINT = 72;
// Dragging leaves the automatic width behind, so it may go narrower than the
// responsive floor and as wide as half the pane before the list starves it.
const PANE_SIDEBAR_DRAG_MIN_WIDTH = 10;
const PANE_SIDEBAR_DRAG_MAX_RATIO = 0.5;

/**
 * A sidebar earns its space once there is more than one thing to switch
 * between, in a pane wide and tall enough to spare it.
 */
export function shouldShowPaneSidebar(
  itemCount: number,
  width: number,
  height: number,
  minimumItemCount = 2,
): boolean {
  return itemCount >= minimumItemCount && width >= PANE_SIDEBAR_BREAKPOINT && height >= 8;
}

/** The width range a dragged sidebar may take inside a pane of `width` cells. */
export function getPaneSidebarWidthRange(width: number): { min: number; max: number } {
  return {
    min: PANE_SIDEBAR_DRAG_MIN_WIDTH,
    max: Math.max(PANE_SIDEBAR_DRAG_MIN_WIDTH, Math.floor(width * PANE_SIDEBAR_DRAG_MAX_RATIO)),
  };
}

/**
 * A persisted sidebar width as a usable one. Anything that is not a finite
 * number reads as "follow the pane", which is what an absent, corrupted or
 * older stored value should mean rather than a zero width sidebar.
 */
export function readStoredPaneSidebarWidth(stored: unknown): number | null {
  return typeof stored === "number" && Number.isFinite(stored) ? stored : null;
}

export function getPaneSidebarWidth(
  width: number,
  nativePaneChrome: boolean,
  preferredWidth?: number | null,
): number {
  if (preferredWidth != null && Number.isFinite(preferredWidth)) {
    const range = getPaneSidebarWidthRange(width);
    return Math.min(range.max, Math.max(range.min, Math.round(preferredWidth)));
  }
  const minimumWidth = nativePaneChrome ? DESKTOP_PANE_SIDEBAR_MIN_WIDTH : PANE_SIDEBAR_MIN_WIDTH;
  const maximumWidth = nativePaneChrome ? DESKTOP_PANE_SIDEBAR_MAX_WIDTH : PANE_SIDEBAR_MAX_WIDTH;
  const widthRatio = nativePaneChrome ? DESKTOP_PANE_SIDEBAR_WIDTH_RATIO : PANE_SIDEBAR_WIDTH_RATIO;
  return Math.min(maximumWidth, Math.max(minimumWidth, Math.floor(width * widthRatio)));
}
