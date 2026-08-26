import type { FloatingPaneEntry, LayoutConfig } from "../../types/config";
import {
  boundsForRects,
  inferDockTreeFromRects,
  type GridlockRect,
} from "./gridlock-inference";
import {
  getDockedInstanceIds,
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
export const TIDY_WINDOW_LIMIT = 6;

type Rect = Pick<FloatingPaneEntry, "x" | "y" | "width" | "height">;

export interface FloatingPaneVisibility {
  instanceId: string;
  buried: boolean;
  visibleRatio: number;
  titleBarVisibleRatio: number;
}

export interface TidyWindowsPlan {
  show: boolean;
  requiresChoice: boolean;
  capacity: number;
  buriedCount: number;
  visibleCount: number;
  floatingPanes: FloatingPaneVisibility[];
  selectedFloatingPaneIds: string[];
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

export function planTidyWindows(
  layout: LayoutConfig,
  focusedPaneId: string | null,
  limit = TIDY_WINDOW_LIMIT,
): TidyWindowsPlan {
  const floatingPanes = analyzeFloatingPaneVisibility(layout);
  const buriedCount = floatingPanes.filter((pane) => pane.buried).length;
  const capacity = Math.max(0, limit - getDockedInstanceIds(layout.dockRoot).length);
  const focusedFloating = floatingPanes.find((pane) => pane.instanceId === focusedPaneId);
  const preferred = [
    ...(focusedFloating ? [focusedFloating] : []),
    ...floatingPanes.filter((pane) => !pane.buried && pane.instanceId !== focusedPaneId),
  ];
  const selectedFloatingPaneIds = preferred.slice(0, capacity).map((pane) => pane.instanceId);

  return {
    show: layout.floating.length >= TIDY_FLOATING_THRESHOLD || buriedCount > 0,
    requiresChoice: buriedCount > 0 || selectedFloatingPaneIds.length < layout.floating.length,
    capacity,
    buriedCount,
    visibleCount: floatingPanes.length - buriedCount,
    floatingPanes,
    selectedFloatingPaneIds,
  };
}

function gridlockPanes(
  layout: LayoutConfig,
  selectedFloatingPaneIds: ReadonlySet<string> | null,
  bounds: LayoutBounds,
  paneTypes?: PaneTypeAvailability,
): LayoutConfig {
  const visibleLayout = paneTypes
    ? removeUnavailablePaneTypes(layout, paneTypes)
    : layout;
  const selectedFloating = selectedFloatingPaneIds
    ? visibleLayout.floating.filter((entry) => selectedFloatingPaneIds.has(entry.instanceId))
    : visibleLayout.floating;
  if (selectedFloatingPaneIds && selectedFloating.length === 0) return visibleLayout;

  const dockedRects: GridlockRect[] = getDockLeafLayouts(visibleLayout, bounds)
    .map((leaf) => ({ instanceId: leaf.instanceId, ...leaf.rect }));
  const floatingRects: GridlockRect[] = selectedFloating.map((entry) => ({
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
    floating: selectedFloatingPaneIds
      ? visibleLayout.floating.filter((entry) => !selectedFloatingPaneIds.has(entry.instanceId))
      : [],
  });
}

export function gridlockFloatingPanes(
  layout: LayoutConfig,
  floatingPaneIds: readonly string[],
  bounds: LayoutBounds = { x: 0, y: 0, width: 120, height: 40 },
  paneTypes?: PaneTypeAvailability,
): LayoutConfig {
  if (floatingPaneIds.length === 0) return layout;
  return gridlockPanes(layout, new Set(floatingPaneIds), bounds, paneTypes);
}

export function gridlockAllPanes(
  layout: LayoutConfig,
  bounds: LayoutBounds = { x: 0, y: 0, width: 120, height: 40 },
  paneTypes?: PaneTypeAvailability,
): LayoutConfig {
  return gridlockPanes(layout, null, bounds, paneTypes);
}
