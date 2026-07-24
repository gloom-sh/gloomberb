import {
  MIN_FLOAT_HEIGHT,
  MIN_FLOAT_WIDTH,
  floatAtRect,
  getDockLeafLayouts,
  simulateDrop,
  snapPaneToGridRect,
  type DockLeafLayout,
  type DropTarget,
  type FloatingRect,
  type FloatingResizeCorner,
  type LayoutBounds,
} from "../../../../plugins/pane-manager";
import type { DesktopDockPreviewState } from "../../../../types/desktop-window";
import type { LayoutConfig } from "../../../../types/config";

export interface HoverOverlay {
  targetId: string;
  rect: LayoutBounds;
  cells: Array<{ position: "top" | "left" | "center" | "right" | "bottom"; rect: LayoutBounds }>;
}

type SnapGuidePosition = `cell-${number}-${number}`;

export interface SnapGuide {
  position: SnapGuidePosition;
  column: number;
  row: number;
  triggerRect: LayoutBounds;
  previewRect: FloatingRect;
}

export interface DragPreviewRect {
  instanceId: string;
  rect: LayoutBounds;
}

export type DragPreview =
  | {
    kind: "compact";
    layout: LayoutConfig;
    rect: LayoutBounds;
    rects: DragPreviewRect[];
  }
  | {
    kind: "dock";
    target: DropTarget;
    layout: LayoutConfig;
    rect: LayoutBounds;
    rects: DragPreviewRect[];
  }
  | {
    kind: "snap";
    position: SnapGuidePosition;
    layout: LayoutConfig;
    rect: FloatingRect;
    rects: DragPreviewRect[];
  };

export interface PaneDragReleaseResult {
  nextLayout: LayoutConfig;
  shouldShowGridlockTip: boolean;
}

export interface PaneDragRectState {
  mode: "docked" | "floating";
  startX: number;
  startY: number;
  origRect: FloatingRect;
}

export interface FloatResizeDragState {
  corner: FloatingResizeCorner;
  startX: number;
  startY: number;
  origRect: FloatingRect;
}

const DOCK_DIVIDER_SIZE = 1;
export const PANE_DRAG_THRESHOLD = 2;
export const PRECISE_PANE_DRAG_THRESHOLD = 0.15;
export const LAYOUT_GRID_COLUMNS = 6;
export const LAYOUT_GRID_ROWS = 6;

export interface LayoutGridCell {
  column: number;
  row: number;
  rect: LayoutBounds;
}

export function makeLayoutGridCells(
  width: number,
  height: number,
  columns = LAYOUT_GRID_COLUMNS,
  rows = LAYOUT_GRID_ROWS,
): LayoutGridCell[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  const columnCount = Math.max(1, Math.min(Math.floor(columns), safeWidth));
  const rowCount = Math.max(1, Math.min(Math.floor(rows), safeHeight));
  const cells: LayoutGridCell[] = [];

  for (let row = 0; row < rowCount; row += 1) {
    const y = Math.floor((safeHeight * row) / rowCount);
    const bottom = Math.floor((safeHeight * (row + 1)) / rowCount);
    for (let column = 0; column < columnCount; column += 1) {
      const x = Math.floor((safeWidth * column) / columnCount);
      const right = Math.floor((safeWidth * (column + 1)) / columnCount);
      cells.push({
        column,
        row,
        rect: {
          x,
          y,
          width: Math.max(1, right - x),
          height: Math.max(1, bottom - y),
        },
      });
    }
  }

  return cells;
}

export function pointInRect(rect: LayoutBounds, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

export function isMeaningfulPaneDrag(startX: number, startY: number, currentX: number, currentY: number, threshold = PANE_DRAG_THRESHOLD): boolean {
  return Math.max(Math.abs(currentX - startX), Math.abs(currentY - startY)) >= threshold;
}

function clampFinite(value: number, min: number, max: number, fallback = min): number {
  const normalized = Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, normalized));
}

function fitFloatingDimension(value: number, min: number, available: number): number {
  const max = Math.max(1, Number.isFinite(available) ? available : 1);
  const boundedMin = Math.min(min, max);
  return clampFinite(value, boundedMin, max, boundedMin);
}

export function constrainFloatingRectToBounds(
  rect: FloatingRect,
  totalWidth: number,
  totalHeight: number,
): FloatingRect {
  const boundsWidth = Math.max(1, Number.isFinite(totalWidth) ? totalWidth : 1);
  const boundsHeight = Math.max(1, Number.isFinite(totalHeight) ? totalHeight : 1);
  const width = fitFloatingDimension(rect.width, rect.fixedGeometry ? 1 : MIN_FLOAT_WIDTH, boundsWidth);
  const height = fitFloatingDimension(rect.height, rect.fixedGeometry ? 1 : MIN_FLOAT_HEIGHT, boundsHeight);
  const maxX = Math.max(0, boundsWidth - width);
  const maxY = Math.max(0, boundsHeight - height);

  return {
    ...rect,
    x: clampFinite(rect.x, 0, maxX, 0),
    y: clampFinite(rect.y, 0, maxY, 0),
    width,
    height,
  };
}

function positionFloatingRectUnderPointer(
  rect: FloatingRect,
  drag: PaneDragRectState,
  pointerX: number,
  pointerY: number,
  totalWidth: number,
  totalHeight: number,
): FloatingRect {
  const fittedRect = constrainFloatingRectToBounds(rect, totalWidth, totalHeight);
  const pointerOffsetX = Math.max(0, Math.min(fittedRect.width - 1, drag.startX - drag.origRect.x));
  const pointerOffsetY = Math.max(0, Math.min(fittedRect.height - 1, drag.startY - drag.origRect.y));
  return constrainFloatingRectToBounds({
    ...fittedRect,
    x: pointerX - pointerOffsetX,
    y: pointerY - pointerOffsetY,
  }, totalWidth, totalHeight);
}

export function resolvePaneDragFloatingRect(
  drag: PaneDragRectState,
  baseRect: FloatingRect,
  pointerX: number,
  pointerY: number,
  totalWidth: number,
  totalHeight: number,
): FloatingRect {
  if (drag.mode === "docked") {
    return positionFloatingRectUnderPointer(baseRect, drag, pointerX, pointerY, totalWidth, totalHeight);
  }

  return constrainFloatingRectToBounds({
    ...drag.origRect,
    x: drag.origRect.x + (pointerX - drag.startX),
    y: drag.origRect.y + (pointerY - drag.startY),
    width: drag.origRect.width,
    height: drag.origRect.height,
  }, totalWidth, totalHeight);
}

export function resolveFloatResizeRect(
  drag: FloatResizeDragState,
  pointerX: number,
  pointerY: number,
  totalWidth: number,
  totalHeight: number,
): FloatingRect {
  const dx = pointerX - drag.startX;
  const dy = pointerY - drag.startY;
  const minWidth = drag.origRect.fixedGeometry ? 1 : MIN_FLOAT_WIDTH;
  const minHeight = drag.origRect.fixedGeometry ? 1 : MIN_FLOAT_HEIGHT;
  let left = drag.origRect.x;
  let top = drag.origRect.y;
  let right = drag.origRect.x + drag.origRect.width;
  let bottom = drag.origRect.y + drag.origRect.height;
  const affectsLeft = drag.corner === "top-left" || drag.corner === "bottom-left" || drag.corner === "left";
  const affectsRight = drag.corner === "top-right" || drag.corner === "bottom-right" || drag.corner === "right";
  const affectsTop = drag.corner === "top-left" || drag.corner === "top-right" || drag.corner === "top";
  const affectsBottom = drag.corner === "bottom-left" || drag.corner === "bottom-right" || drag.corner === "bottom";

  if (affectsLeft) {
    left = Math.max(0, Math.min(left + dx, right - minWidth));
  } else if (affectsRight) {
    right = Math.min(totalWidth, Math.max(right + dx, left + minWidth));
  }

  if (affectsTop) {
    top = Math.max(0, Math.min(top + dy, bottom - minHeight));
  } else if (affectsBottom) {
    bottom = Math.min(totalHeight, Math.max(bottom + dy, top + minHeight));
  }

  return constrainFloatingRectToBounds({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    zIndex: drag.origRect.zIndex,
    fixedGeometry: drag.origRect.fixedGeometry,
  }, totalWidth, totalHeight);
}

function centerRectWithin(parent: LayoutBounds, width: number, height: number): LayoutBounds {
  const nextWidth = Math.max(1, Math.min(parent.width, width));
  const nextHeight = Math.max(1, Math.min(parent.height, height));
  return {
    x: parent.x + Math.floor((parent.width - nextWidth) / 2),
    y: parent.y + Math.floor((parent.height - nextHeight) / 2),
    width: nextWidth,
    height: nextHeight,
  };
}

function compactOverlayRect(rect: LayoutBounds): LayoutBounds {
  if (rect.width < 12 || rect.height < 7) return rect;
  return centerRectWithin(
    rect,
    Math.max(9, Math.min(19, Math.floor(rect.width * 0.45))),
    Math.max(5, Math.min(9, Math.floor(rect.height * 0.45))),
  );
}

function makeOverlayCellRects(rect: LayoutBounds): HoverOverlay["cells"] {
  const col1 = Math.max(1, Math.floor(rect.width / 3));
  const col2 = Math.max(1, Math.floor((rect.width - col1) / 2));
  const col3 = Math.max(1, rect.width - col1 - col2);
  const row1 = Math.max(1, Math.floor(rect.height / 3));
  const row2 = Math.max(1, Math.floor((rect.height - row1) / 2));
  const row3 = Math.max(1, rect.height - row1 - row2);
  const cols = [col1, col2, col3];
  const rows = [row1, row2, row3];
  const cells: HoverOverlay["cells"] = [];
  let y = rect.y;
  for (let rowIndex = 0; rowIndex < 3; rowIndex += 1) {
    let x = rect.x;
    for (let colIndex = 0; colIndex < 3; colIndex += 1) {
      const position = (
        rowIndex === 0 && colIndex === 1 ? "top"
          : rowIndex === 1 && colIndex === 0 ? "left"
            : rowIndex === 1 && colIndex === 1 ? "center"
              : rowIndex === 1 && colIndex === 2 ? "right"
                : rowIndex === 2 && colIndex === 1 ? "bottom"
                  : null
      );
      if (position) {
        cells.push({
          position,
          rect: { x, y, width: cols[colIndex]!, height: rows[rowIndex]! },
        });
      }
      x += cols[colIndex]!;
    }
    y += rows[rowIndex]!;
  }
  return cells;
}

export function resolveHoverOverlay(
  x: number,
  y: number,
  leaves: DockLeafLayout[],
  draggedPaneId: string,
): HoverOverlay | null {
  const targetLeaf = leaves.find((leaf) => leaf.instanceId !== draggedPaneId && pointInRect(leaf.rect, x, y));
  if (!targetLeaf) return null;
  const overlayRect = compactOverlayRect(targetLeaf.rect);
  if (!pointInRect(overlayRect, x, y)) return null;
  return {
    targetId: targetLeaf.instanceId,
    rect: overlayRect,
    cells: makeOverlayCellRects(overlayRect),
  };
}

function sameRect(left: LayoutBounds, right: LayoutBounds): boolean {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

export function changedDockPreviewRects(
  layout: LayoutConfig,
  nextLayout: LayoutConfig,
  bounds: LayoutBounds,
  options?: Parameters<typeof getDockLeafLayouts>[2],
): DragPreviewRect[] {
  const currentRects = new Map(
    getDockLeafLayouts(layout, bounds, options).map((leaf) => [leaf.instanceId, leaf.rect]),
  );
  return getDockLeafLayouts(nextLayout, bounds, options)
    .filter((leaf) => {
      const currentRect = currentRects.get(leaf.instanceId);
      return !currentRect || !sameRect(currentRect, leaf.rect);
    })
    .map(({ instanceId, rect }) => ({ instanceId, rect }));
}

export function createLeafDropPreview(
  layout: LayoutConfig,
  paneId: string,
  target: DropTarget,
  bounds: LayoutBounds,
  options?: Parameters<typeof getDockLeafLayouts>[2],
): Extract<DragPreview, { kind: "dock" }> | null {
  const simulation = simulateDrop(layout, paneId, target, bounds, options);
  if (!simulation.previewRect) return null;
  return {
    kind: "dock",
    target,
    layout: simulation.layout,
    rect: simulation.previewRect,
    rects: changedDockPreviewRects(layout, simulation.layout, bounds, options),
  };
}

function resolveCompactedDropPosition(
  targetRect: LayoutBounds,
  pointerX: number,
  pointerY: number,
): "top" | "left" | "right" | "bottom" {
  const horizontal = (pointerX - (targetRect.x + (targetRect.width / 2))) / Math.max(1, targetRect.width);
  const vertical = (pointerY - (targetRect.y + (targetRect.height / 2))) / Math.max(1, targetRect.height);
  if (Math.abs(horizontal) >= Math.abs(vertical)) {
    return horizontal < 0 ? "left" : "right";
  }
  return vertical < 0 ? "top" : "bottom";
}

export function createCompactedDropPreview(
  layout: LayoutConfig,
  paneId: string,
  targetLeaf: DockLeafLayout,
  pointerX: number,
  pointerY: number,
  bounds: LayoutBounds,
  options?: Parameters<typeof getDockLeafLayouts>[2],
): Extract<DragPreview, { kind: "compact" }> | null {
  const preview = createLeafDropPreview(
    layout,
    paneId,
    {
      kind: "leaf",
      targetId: targetLeaf.instanceId,
      position: resolveCompactedDropPosition(targetLeaf.rect, pointerX, pointerY),
    },
    bounds,
    options,
  );
  return preview
    ? {
      kind: "compact",
      layout: preview.layout,
      rect: preview.rect,
      rects: preview.rects,
    }
    : null;
}

export function createSnapDropPreview(
  layout: LayoutConfig,
  paneId: string,
  position: SnapGuidePosition,
  targetRect: LayoutBounds,
  bounds: LayoutBounds,
  options?: Parameters<typeof getDockLeafLayouts>[2],
): Extract<DragPreview, { kind: "snap" }> {
  const nextLayout = snapPaneToGridRect(layout, paneId, targetRect, bounds);
  return {
    kind: "snap",
    position,
    layout: nextLayout,
    rect: targetRect,
    rects: [
      { instanceId: paneId, rect: targetRect },
      ...changedDockPreviewRects(layout, nextLayout, bounds, options)
        .filter((entry) => entry.instanceId !== paneId),
    ],
  };
}

export function resolveDividerPreviewRect(
  axis: "horizontal" | "vertical",
  bounds: LayoutBounds,
  ratio: number,
  nativePaneChrome: boolean,
): LayoutBounds {
  if (axis === "horizontal") {
    const offset = nativePaneChrome
      ? bounds.width * ratio
      : bounds.width > DOCK_DIVIDER_SIZE
        ? Math.round((bounds.width - DOCK_DIVIDER_SIZE) * ratio)
        : Math.max(0, Math.round(bounds.width * ratio) - DOCK_DIVIDER_SIZE);
    return {
      x: nativePaneChrome ? bounds.x + offset - (DOCK_DIVIDER_SIZE / 2) : bounds.x + offset,
      y: bounds.y,
      width: DOCK_DIVIDER_SIZE,
      height: bounds.height,
    };
  }

  const offset = nativePaneChrome
    ? bounds.height * ratio
    : bounds.height > DOCK_DIVIDER_SIZE
      ? Math.round((bounds.height - DOCK_DIVIDER_SIZE) * ratio)
      : Math.max(0, Math.round(bounds.height * ratio) - DOCK_DIVIDER_SIZE);
  return {
    x: bounds.x,
    y: nativePaneChrome ? bounds.y + offset - (DOCK_DIVIDER_SIZE / 2) : bounds.y + offset,
    width: bounds.width,
    height: DOCK_DIVIDER_SIZE,
  };
}

export function finalizePaneDragRelease(
  layout: LayoutConfig,
  paneId: string,
  previewRect: FloatingRect,
  dockPreview: DragPreview | null,
): PaneDragReleaseResult {
  if (dockPreview?.kind === "compact") {
    return {
      nextLayout: dockPreview.layout,
      shouldShowGridlockTip: false,
    };
  }

  if (dockPreview?.kind === "dock") {
    return {
      nextLayout: dockPreview.layout,
      shouldShowGridlockTip: false,
    };
  }

  if (dockPreview?.kind === "snap") {
    return {
      nextLayout: dockPreview.layout,
      shouldShowGridlockTip: false,
    };
  }

  return {
    nextLayout: floatAtRect(layout, paneId, previewRect),
    shouldShowGridlockTip: false,
  };
}

export function makeSnapGuides(width: number, height: number): SnapGuide[] {
  return makeLayoutGridCells(width, height).map((cell) => ({
    position: `cell-${cell.column + 1}-${cell.row + 1}`,
    column: cell.column,
    row: cell.row,
    triggerRect: cell.rect,
    previewRect: cell.rect,
  }));
}

export function resolveSnapGuide(x: number, y: number, guides: SnapGuide[]): SnapGuide | null {
  return guides.find((guide) => pointInRect(guide.triggerRect, x, y)) ?? null;
}

export function resolveExternalDockPreview(
  preview: DesktopDockPreviewState | null | undefined,
  bounds: LayoutBounds,
  layout: LayoutConfig,
  options?: Parameters<typeof getDockLeafLayouts>[2],
): DragPreview | null {
  if (!preview?.paneId || !preview.edge) return null;
  const target: DropTarget = { kind: "frame", edge: preview.edge };
  const resolved = createLeafDropPreview(layout, preview.paneId, target, bounds, options);
  if (!resolved) return null;

  switch (preview.edge) {
    case "left":
      return {
        ...resolved,
        rect: { x: bounds.x, y: bounds.y, width: Math.max(1, Math.floor(bounds.width / 2)), height: bounds.height },
      };
    case "right": {
      const width = Math.max(1, Math.floor(bounds.width / 2));
      return {
        ...resolved,
        rect: { x: bounds.x + Math.max(0, bounds.width - width), y: bounds.y, width, height: bounds.height },
      };
    }
    case "top":
      return {
        ...resolved,
        rect: { x: bounds.x, y: bounds.y, width: bounds.width, height: Math.max(1, Math.floor(bounds.height / 2)) },
      };
    case "bottom": {
      const height = Math.max(1, Math.floor(bounds.height / 2));
      return {
        ...resolved,
        rect: { x: bounds.x, y: bounds.y + Math.max(0, bounds.height - height), width: bounds.width, height },
      };
    }
    default:
      return null;
  }
}
