import type { LayoutConfig } from "../../types/config";
import {
  boundsForRects,
  inferCompactedDockTree,
  inferDockTreeFromRects,
  type GridlockRect,
} from "./gridlock-inference";
import {
  findDockLeaf,
  getDockedPaneIds,
  getDockLeafLayouts,
  type LayoutBounds,
} from "./dock-tree";
import {
  finalizeLayout,
  removeUnavailablePaneTypes,
  type PaneTypeAvailability,
} from "./layout-state";
import { floatAtRect } from "./floating-actions";

export const LAYOUT_PRESET_IDS = ["single", "2x2", "3x3", "left-main"] as const;
export type LayoutPresetId = typeof LAYOUT_PRESET_IDS[number];

function splitDimension(total: number, parts: number, index: number): { start: number; size: number } {
  const start = Math.floor((total * index) / parts);
  const end = Math.floor((total * (index + 1)) / parts);
  return { start, size: Math.max(1, end - start) };
}

function visiblePaneIds(layout: LayoutConfig): string[] {
  return [
    ...getDockedPaneIds(layout),
    ...layout.floating.map((entry) => entry.instanceId),
  ];
}

function makeGridPresetRects(
  instanceIds: string[],
  bounds: LayoutBounds,
  columns: number,
): GridlockRect[] {
  const columnCount = Math.max(1, Math.min(columns, instanceIds.length));
  const rowCount = Math.max(1, Math.ceil(instanceIds.length / columnCount));
  return instanceIds.map((instanceId, index) => {
    const column = index % columnCount;
    const row = Math.floor(index / columnCount);
    const horizontal = splitDimension(bounds.width, columnCount, column);
    const vertical = splitDimension(bounds.height, rowCount, row);
    return {
      instanceId,
      x: bounds.x + horizontal.start,
      y: bounds.y + vertical.start,
      width: horizontal.size,
      height: vertical.size,
    };
  });
}

function makeLeftMainPresetRects(instanceIds: string[], bounds: LayoutBounds): GridlockRect[] {
  if (instanceIds.length <= 1) {
    return instanceIds.map((instanceId) => ({ instanceId, ...bounds }));
  }

  const left = splitDimension(bounds.width, 2, 0);
  const right = splitDimension(bounds.width, 2, 1);
  const stackedIds = instanceIds.slice(1);
  return [
    {
      instanceId: instanceIds[0]!,
      x: bounds.x + left.start,
      y: bounds.y,
      width: left.size,
      height: bounds.height,
    },
    ...stackedIds.map((instanceId, index) => {
      const vertical = splitDimension(bounds.height, stackedIds.length, index);
      return {
        instanceId,
        x: bounds.x + right.start,
        y: bounds.y + vertical.start,
        width: right.size,
        height: vertical.size,
      };
    }),
  ];
}

export function applyLayoutPreset(
  layout: LayoutConfig,
  preset: LayoutPresetId,
  bounds: LayoutBounds = { x: 0, y: 0, width: 120, height: 40 },
  paneTypes?: PaneTypeAvailability,
): LayoutConfig {
  const visibleLayout = paneTypes
    ? removeUnavailablePaneTypes(layout, paneTypes)
    : layout;
  const instanceIds = visiblePaneIds(visibleLayout);
  if (instanceIds.length === 0) return visibleLayout;

  const rects = preset === "left-main"
    ? makeLeftMainPresetRects(instanceIds, bounds)
    : makeGridPresetRects(instanceIds, bounds, preset === "single" ? 1 : preset === "2x2" ? 2 : 3);

  return finalizeLayout({
    ...visibleLayout,
    dockRoot: inferDockTreeFromRects(rects, bounds),
    floating: visibleLayout.floating.filter((entry) => !instanceIds.includes(entry.instanceId)),
  });
}

export function snapPaneToGridRect(
  layout: LayoutConfig,
  instanceId: string,
  targetRect: LayoutBounds,
  _bounds: LayoutBounds,
): LayoutConfig {
  const visibleIds = new Set(visiblePaneIds(layout));
  if (!visibleIds.has(instanceId)) return layout;
  return floatAtRect(layout, instanceId, { ...targetRect, fixedGeometry: true });
}

export function compactDockedPaneAtRect(
  layout: LayoutConfig,
  draggedInstanceId: string,
  targetRect: LayoutBounds,
  bounds: LayoutBounds,
): LayoutConfig {
  if (!findDockLeaf(layout, draggedInstanceId)) return layout;
  const dockRoot = inferCompactedDockTree(layout, draggedInstanceId, targetRect, bounds);
  if (!dockRoot) return layout;
  return finalizeLayout({
    ...layout,
    dockRoot,
    floating: layout.floating,
  });
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
