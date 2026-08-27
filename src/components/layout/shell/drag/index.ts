import {
  MIN_FLOAT_HEIGHT,
  MIN_FLOAT_WIDTH,
  applyDrop,
  floatAtRect,
  type DockLeafLayout,
  type DropTarget,
  type FloatingRect,
  type LayoutBounds,
} from "../../../../plugins/pane-manager";
import type { DesktopDockPreviewState } from "../../../../types/desktop-window";
import type { LayoutConfig } from "../../../../types/config";
import { PANE_HEADER_ACTION, PANE_HEADER_CLOSE } from "../../pane/header";

export interface HoverOverlay {
  targetId: string;
  rect: LayoutBounds;
  cells: Array<{ position: "top" | "left" | "center" | "right" | "bottom"; rect: LayoutBounds }>;
}

type SnapGuidePosition =
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export interface SnapGuide {
  position: SnapGuidePosition;
  triggerRect: LayoutBounds;
  previewRect: FloatingRect;
}

export type DragPreview =
  | {
    kind: "dock";
    target: DropTarget;
    rect: LayoutBounds;
  }
  | {
    kind: "snap";
    position: SnapGuidePosition;
    rect: FloatingRect;
  };

export interface PaneDragRectState {
  mode: "docked" | "floating";
  startX: number;
  startY: number;
  origRect: FloatingRect;
}

export interface FloatResizeDragState {
  startX: number;
  startY: number;
  origRect: FloatingRect;
}

const DOCK_DIVIDER_SIZE = 1;
export const PANE_DRAG_THRESHOLD = 2;
export const PRECISE_PANE_DRAG_THRESHOLD = 0.15;

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
  const width = fitFloatingDimension(rect.width, MIN_FLOAT_WIDTH, boundsWidth);
  const height = fitFloatingDimension(rect.height, MIN_FLOAT_HEIGHT, boundsHeight);
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
  return constrainFloatingRectToBounds({
    x: drag.origRect.x,
    y: drag.origRect.y,
    width: Math.max(MIN_FLOAT_WIDTH, Math.min(totalWidth - drag.origRect.x, drag.origRect.width + (pointerX - drag.startX))),
    height: Math.max(MIN_FLOAT_HEIGHT, Math.min(totalHeight - drag.origRect.y, drag.origRect.height + (pointerY - drag.startY))),
    zIndex: drag.origRect.zIndex,
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
): LayoutConfig {
  if (dockPreview?.kind === "dock") {
    return applyDrop(layout, paneId, dockPreview.target);
  }
  if (dockPreview?.kind === "snap") {
    return floatAtRect(layout, paneId, dockPreview.rect);
  }
  return floatAtRect(layout, paneId, previewRect);
}

export function makeSnapGuides(width: number, height: number): SnapGuide[] {
  const halfWidth = Math.max(1, Math.floor(width / 2));
  const halfHeight = Math.max(1, Math.floor(height / 2));
  const cornerWidth = Math.max(8, Math.min(16, Math.floor(width * 0.2)));
  const cornerHeight = Math.max(4, Math.min(8, Math.floor(height * 0.22)));
  const edgeWidth = Math.max(6, Math.min(10, Math.floor(width * 0.1)));
  const topBottomEdgeHeight = Math.max(2, Math.min(4, Math.floor(height * 0.1)));

  return [
    {
      position: "top-left",
      triggerRect: { x: 0, y: 0, width: cornerWidth, height: cornerHeight },
      previewRect: { x: 0, y: 0, width: halfWidth, height: halfHeight },
    },
    {
      position: "top-right",
      triggerRect: { x: Math.max(0, width - cornerWidth), y: 0, width: cornerWidth, height: cornerHeight },
      previewRect: { x: Math.max(0, width - halfWidth), y: 0, width: halfWidth, height: halfHeight },
    },
    {
      position: "bottom-left",
      triggerRect: { x: 0, y: Math.max(0, height - cornerHeight), width: cornerWidth, height: cornerHeight },
      previewRect: { x: 0, y: Math.max(0, height - halfHeight), width: halfWidth, height: halfHeight },
    },
    {
      position: "bottom-right",
      triggerRect: {
        x: Math.max(0, width - cornerWidth),
        y: Math.max(0, height - cornerHeight),
        width: cornerWidth,
        height: cornerHeight,
      },
      previewRect: {
        x: Math.max(0, width - halfWidth),
        y: Math.max(0, height - halfHeight),
        width: halfWidth,
        height: halfHeight,
      },
    },
    {
      position: "left",
      triggerRect: { x: 0, y: cornerHeight, width: edgeWidth, height: Math.max(1, height - (cornerHeight * 2)) },
      previewRect: { x: 0, y: 0, width: halfWidth, height },
    },
    {
      position: "right",
      triggerRect: {
        x: Math.max(0, width - edgeWidth),
        y: cornerHeight,
        width: edgeWidth,
        height: Math.max(1, height - (cornerHeight * 2)),
      },
      previewRect: { x: Math.max(0, width - halfWidth), y: 0, width: halfWidth, height },
    },
    {
      position: "top",
      triggerRect: { x: cornerWidth, y: 0, width: Math.max(1, width - (cornerWidth * 2)), height: topBottomEdgeHeight },
      previewRect: { x: 0, y: 0, width, height: halfHeight },
    },
    {
      position: "bottom",
      triggerRect: {
        x: cornerWidth,
        y: Math.max(0, height - topBottomEdgeHeight),
        width: Math.max(1, width - (cornerWidth * 2)),
        height: topBottomEdgeHeight,
      },
      previewRect: { x: 0, y: Math.max(0, height - halfHeight), width, height: halfHeight },
    },
  ];
}

export function resolveSnapGuide(x: number, y: number, guides: SnapGuide[]): SnapGuide | null {
  return guides.find((guide) => pointInRect(guide.triggerRect, x, y)) ?? null;
}

export function resolveHeaderHitAreas(
  width: number,
  options: { floating: boolean; focused: boolean },
): {
  actionStart: number | null;
  closeStart: number | null;
} {
  // Focused panes and all floating panes render corner chrome around the header.
  let rightEdge = options.focused || options.floating ? width - 2 : width;
  let closeStart: number | null = null;
  let actionStart: number | null = null;

  if (options.floating) {
    closeStart = Math.max(0, rightEdge - PANE_HEADER_CLOSE.length);
    rightEdge = closeStart;
  }

  actionStart = Math.max(0, rightEdge - PANE_HEADER_ACTION.length);

  return { actionStart, closeStart };
}

export function resolveExternalDockPreview(
  preview: DesktopDockPreviewState | null | undefined,
  bounds: LayoutBounds,
): DragPreview | null {
  if (!preview?.paneId || !preview.edge) return null;

  switch (preview.edge) {
    case "left":
      return {
        kind: "dock",
        target: { kind: "frame", edge: "left" },
        rect: { x: bounds.x, y: bounds.y, width: Math.max(1, Math.floor(bounds.width / 2)), height: bounds.height },
      };
    case "right": {
      const width = Math.max(1, Math.floor(bounds.width / 2));
      return {
        kind: "dock",
        target: { kind: "frame", edge: "right" },
        rect: { x: bounds.x + Math.max(0, bounds.width - width), y: bounds.y, width, height: bounds.height },
      };
    }
    case "top":
      return {
        kind: "dock",
        target: { kind: "frame", edge: "top" },
        rect: { x: bounds.x, y: bounds.y, width: bounds.width, height: Math.max(1, Math.floor(bounds.height / 2)) },
      };
    case "bottom": {
      const height = Math.max(1, Math.floor(bounds.height / 2));
      return {
        kind: "dock",
        target: { kind: "frame", edge: "bottom" },
        rect: { x: bounds.x, y: bounds.y + Math.max(0, bounds.height - height), width: bounds.width, height },
      };
    }
    default:
      return null;
  }
}
