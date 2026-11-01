import {
  MIN_FLOAT_HEIGHT,
  MIN_FLOAT_WIDTH,
  applyDrop,
  floatAtRect,
  type DockLeafLayout,
  type DropTarget,
  type FloatingRect,
  type LayoutBounds,
} from "../../../../layout/pane-manager";
import type { DesktopDockPreviewState } from "../../../../types/desktop-window";
import type { LayoutConfig } from "../../../../types/config";
import { PANE_HEADER_ACTION, PANE_HEADER_CLOSE, PANE_HEADER_HELP, PANE_HEADER_RESTORE } from "../../pane/header";

export type SnapGuidePosition =
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

/**
 * The edges of a floating pane a resize moves: -1 the left or top edge, 1 the
 * right or bottom one, 0 neither on that axis.
 */
export interface ResizeEdges {
  x: -1 | 0 | 1;
  y: -1 | 0 | 1;
}

/** The bottom-right corner, the one resize the terminal has. */
const CORNER_RESIZE: ResizeEdges = { x: 1, y: 1 };

export interface FloatResizeDragState {
  startX: number;
  startY: number;
  origRect: FloatingRect;
  /** Omitted: the bottom-right corner. */
  edges?: ResizeEdges;
}

const DOCK_DIVIDER_SIZE = 1;
export const PANE_DRAG_THRESHOLD = 2;
export const PRECISE_PANE_DRAG_THRESHOLD = 0.15;

export function sameRect(a: LayoutBounds, b: LayoutBounds): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
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

/**
 * Where the pointer alone puts a pane on the move, before the screen's edges
 * hold it in: a docked pane at its floating size, held where it was pressed
 * (as far into it as it reaches); a floating one moved by the pointer.
 */
export function freePaneDragRect(
  drag: PaneDragRectState,
  baseRect: FloatingRect,
  pointerX: number,
  pointerY: number,
  totalWidth: number,
  totalHeight: number,
): FloatingRect {
  if (drag.mode === "docked") {
    const fittedRect = constrainFloatingRectToBounds(baseRect, totalWidth, totalHeight);
    const pointerOffsetX = Math.max(0, Math.min(fittedRect.width - 1, drag.startX - drag.origRect.x));
    const pointerOffsetY = Math.max(0, Math.min(fittedRect.height - 1, drag.startY - drag.origRect.y));
    return { ...fittedRect, x: pointerX - pointerOffsetX, y: pointerY - pointerOffsetY };
  }
  return {
    x: drag.origRect.x + (pointerX - drag.startX),
    y: drag.origRect.y + (pointerY - drag.startY),
    width: drag.origRect.width,
    height: drag.origRect.height,
  };
}

export function resolvePaneDragFloatingRect(
  drag: PaneDragRectState,
  baseRect: FloatingRect,
  pointerX: number,
  pointerY: number,
  totalWidth: number,
  totalHeight: number,
): FloatingRect {
  return constrainFloatingRectToBounds(freePaneDragRect(drag, baseRect, pointerX, pointerY, totalWidth, totalHeight), totalWidth, totalHeight);
}

/**
 * Moves one edge of a span by `delta`, keeping it at least `min` long and
 * inside 0..`total`: the far edge (1) grows the length, the near one (-1)
 * moves the start and keeps the far edge where it was.
 */
function resizeSpan(start: number, length: number, delta: number, edge: -1 | 0 | 1, min: number, total: number): [number, number] {
  if (edge === 1) return [start, Math.max(min, Math.min(total - start, length + delta))];
  if (edge === -1) {
    const end = start + length;
    const nextStart = Math.max(0, Math.min(end - min, start + delta));
    return [nextStart, end - nextStart];
  }
  return [start, length];
}

export function resolveFloatResizeRect(
  drag: FloatResizeDragState,
  pointerX: number,
  pointerY: number,
  totalWidth: number,
  totalHeight: number,
): FloatingRect {
  const edges = drag.edges ?? CORNER_RESIZE;
  const { origRect } = drag;
  const [x, width] = resizeSpan(origRect.x, origRect.width, pointerX - drag.startX, edges.x, MIN_FLOAT_WIDTH, totalWidth);
  const [y, height] = resizeSpan(origRect.y, origRect.height, pointerY - drag.startY, edges.y, MIN_FLOAT_HEIGHT, totalHeight);
  return constrainFloatingRectToBounds({ x, y, width, height, zIndex: origRect.zIndex }, totalWidth, totalHeight);
}

/** A distance on each axis, in cells. */
export interface AxisDistance {
  x: number;
  y: number;
}

const JOIN_SIDES = [
  ["left", "x"],
  ["right", "x"],
  ["top", "y"],
  ["bottom", "y"],
] as const;

type JoinSide = (typeof JOIN_SIDES)[number][0];

/**
 * Where a pane on the move lands on release, if anywhere but where it is
 * drawn. Over another spot's title bar it becomes a tab there. Its edge
 * pushed flush against the same edge of the spot under the pointer, it joins
 * the dock on that side: where it is drawn and where the pointer puts it,
 * that edge is within `flush` of the spot's, so a window the screen's edge
 * holds back does not join for touching it. The pointer pushed past an edge
 * of the dock area joins on that side of the spot at that edge. `join` false
 * (Alt) leaves the edges out.
 */
export function resolvePaneDropTarget({
  x,
  y,
  rect,
  free,
  leaves,
  paneId,
  area,
  flush,
  headerRows,
  join,
}: {
  /** The pointer, in shell cells. */
  x: number;
  y: number;
  /** Where the moving pane is drawn, its edges caught by the magnets. */
  rect: LayoutBounds;
  /** Where the pointer alone puts it, past the screen's edges if it goes there. */
  free: LayoutBounds;
  leaves: readonly DockLeafLayout[];
  paneId: string;
  /** The dock area. */
  area: LayoutBounds;
  /** How close its edge comes to a spot's edge to count as flush (the magnets' catch). */
  flush: AxisDistance;
  /** A docked pane's title bar, in rows. */
  headerRows: number;
  join: boolean;
}): DropTarget | null {
  const past: Record<JoinSide, number> = {
    left: area.x - x,
    right: x - (area.x + area.width) + 1e-6,
    top: area.y - y,
    bottom: y - (area.y + area.height) + 1e-6,
  };
  const at = {
    x: Math.max(area.x, Math.min(area.x + area.width - 0.001, x)),
    y: Math.max(area.y, Math.min(area.y + area.height - 0.001, y)),
  };
  const leaf = leaves.find((entry) => pointInRect(entry.rect, at.x, at.y));
  if (!leaf) return null;
  // Its own spot: alone there, nothing to land on; a tab of a stack can
  // leave it for a side of the stack, but is a tab of it already.
  const own = leaf.instanceId === paneId || (leaf.stack?.includes(paneId) ?? false);
  const targetId = leaf.instanceId !== paneId ? leaf.instanceId : leaf.stack?.find((id) => id !== paneId);
  if (!targetId) return null;
  let pushed: { side: JoinSide; by: number } | null = null;
  for (const [side] of JOIN_SIDES) {
    if (past[side] > 0 && (!pushed || past[side] > pushed.by)) pushed = { side, by: past[side] };
  }
  if (pushed) return join ? { kind: "leaf", targetId, position: pushed.side } : null;
  if (y < leaf.rect.y + headerRows) return own ? null : { kind: "tab", targetId };
  if (!join) return null;
  const edgeOf = (box: LayoutBounds, side: JoinSide) => (
    side === "left" ? box.x : side === "right" ? box.x + box.width : side === "top" ? box.y : box.y + box.height
  );
  let best: { side: JoinSide; closeness: number } | null = null;
  for (const [side, axis] of JOIN_SIDES) {
    const line = edgeOf(leaf.rect, side);
    if (Math.abs(edgeOf(free, side) - line) > flush[axis]) continue;
    const closeness = Math.abs(edgeOf(rect, side) - line) / Math.max(flush[axis], 1e-6);
    if (closeness <= 1 && (!best || closeness < best.closeness)) best = { side, closeness };
  }
  return best ? { kind: "leaf", targetId, position: best.side } : null;
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
  options: { floating: boolean; focused: boolean; fullscreen?: boolean },
): {
  /** The `?` that opens the pane's docs, just left of the menu. */
  helpStart: number | null;
  actionStart: number | null;
  closeStart: number | null;
} {
  // Focused panes and all floating panes render corner chrome around the header.
  let rightEdge = options.focused || options.floating || options.fullscreen ? width - 2 : width;
  let closeStart: number | null = null;
  let actionStart: number | null = null;

  if (options.floating || options.fullscreen) {
    const corner = options.fullscreen ? PANE_HEADER_RESTORE : PANE_HEADER_CLOSE;
    closeStart = Math.max(0, rightEdge - corner.length);
    rightEdge = closeStart;
  }

  actionStart = Math.max(0, rightEdge - PANE_HEADER_ACTION.length);
  const helpStart = Math.max(0, actionStart - PANE_HEADER_HELP.length);

  return { helpStart, actionStart, closeStart };
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
