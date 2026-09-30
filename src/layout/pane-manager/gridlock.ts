import type { FloatingPaneEntry, LayoutConfig } from "../../types/config";
import type { AppNotificationRequest } from "../../types/plugin";
import {
  boundsForRects,
  inferDockTreeFromRects,
  type GridlockRect,
} from "./gridlock-inference";
import {
  getDockLeafLayouts,
  type LayoutBounds,
} from "./dock-tree";
import {
  finalizeLayout,
  removeUnavailablePaneTypes,
  type PaneTypeAvailability,
} from "./layout-state";

const BURIED_VISIBLE_RATIO = 0.2;
const TITLE_BAR_HEIGHT_RATIO = 0.12;
const TIDY_FLOATING_THRESHOLD = 3;

type Rect = Pick<FloatingPaneEntry, "x" | "y" | "width" | "height">;

export interface FloatingPaneVisibility {
  instanceId: string;
  buried: boolean;
  visibleRatio: number;
  titleBarVisibleRatio: number;
}

function rectArea(rect: Rect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function subtractRect(rect: Rect, cover: Rect): Rect[] {
  const left = Math.max(rect.x, cover.x);
  const top = Math.max(rect.y, cover.y);
  const right = Math.min(rect.x + rect.width, cover.x + cover.width);
  const bottom = Math.min(rect.y + rect.height, cover.y + cover.height);
  if (left >= right || top >= bottom) return [rect];

  return [
    { x: rect.x, y: rect.y, width: rect.width, height: top - rect.y },
    { x: rect.x, y: bottom, width: rect.width, height: rect.y + rect.height - bottom },
    { x: rect.x, y: top, width: left - rect.x, height: bottom - top },
    { x: right, y: top, width: rect.x + rect.width - right, height: bottom - top },
  ].filter((piece) => piece.width > 0 && piece.height > 0);
}

function visibleRatio(rect: Rect, covers: Rect[]): number {
  const area = rectArea(rect);
  if (area === 0) return 0;
  let pieces = [rect];
  for (const cover of covers) {
    pieces = pieces.flatMap((piece) => subtractRect(piece, cover));
    if (pieces.length === 0) return 0;
  }
  return Math.min(1, pieces.reduce((sum, piece) => sum + rectArea(piece), 0) / area);
}

export function analyzeFloatingPaneVisibility(layout: LayoutConfig): FloatingPaneVisibility[] {
  const frontToBack = layout.floating
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => (
      (right.entry.zIndex ?? 50) - (left.entry.zIndex ?? 50)
      || right.index - left.index
    ));
  const covers: Rect[] = [];

  return frontToBack.map(({ entry }) => {
    const paneVisibleRatio = visibleRatio(entry, covers);
    const titleBar = {
      x: entry.x,
      y: entry.y,
      width: entry.width,
      height: Math.min(entry.height, Math.max(1, entry.height * TITLE_BAR_HEIGHT_RATIO)),
    };
    const titleBarVisibleRatio = visibleRatio(titleBar, covers);
    covers.push(entry);
    return {
      instanceId: entry.instanceId,
      buried: paneVisibleRatio < BURIED_VISIBLE_RATIO || titleBarVisibleRatio < BURIED_VISIBLE_RATIO,
      visibleRatio: paneVisibleRatio,
      titleBarVisibleRatio,
    };
  });
}

export function shouldShowTidyWindows(layout: LayoutConfig): boolean {
  return layout.floating.length >= TIDY_FLOATING_THRESHOLD
    || analyzeFloatingPaneVisibility(layout).some((pane) => pane.buried);
}

export function gridlockAllPanes(
  layout: LayoutConfig,
  bounds: LayoutBounds = { x: 0, y: 0, width: 120, height: 40 },
  paneTypes?: PaneTypeAvailability,
): LayoutConfig {
  const visibleLayout = paneTypes
    ? removeUnavailablePaneTypes(layout, paneTypes)
    : layout;
  const dockedRects: GridlockRect[] = getDockLeafLayouts(visibleLayout, bounds)
    .map((leaf) => ({ instanceId: leaf.instanceId, ...leaf.rect }));
  const floatingRects: GridlockRect[] = visibleLayout.floating.map((entry) => ({
    instanceId: entry.instanceId,
    x: entry.x,
    y: entry.y,
    width: entry.width,
    height: entry.height,
  }));
  const allRects = [...dockedRects, ...floatingRects];
  if (allRects.length === 0) return visibleLayout;

  return finalizeLayout({
    ...visibleLayout,
    dockRoot: inferDockTreeFromRects(allRects, boundsForRects(allRects)),
    floating: [],
  });
}

/**
 * Tidy Windows, for every surface that offers it: retile `layout` into a
 * `size` viewport and hand the result to `apply`. A layout with no panes to
 * tidy stays put, with no toast. Given `notify`, the user is told, and
 * `onRevert` backs the toast's Revert action.
 */
export function tidyWindows({ layout, size, paneTypes, apply, notify, onRevert }: {
  layout: LayoutConfig;
  size: { width: number; height: number };
  paneTypes?: PaneTypeAvailability;
  apply: (layout: LayoutConfig) => void;
  notify?: (notification: AppNotificationRequest) => void;
  onRevert?: () => void;
}): void {
  const nextLayout = gridlockAllPanes(layout, { x: 0, y: 0, width: size.width, height: size.height }, paneTypes);
  if (nextLayout === layout) return;
  apply(nextLayout);
  notify?.({
    body: "Windows tidied",
    type: "success",
    ...(onRevert ? { action: { label: "Revert", onClick: onRevert } } : {}),
  });
}
