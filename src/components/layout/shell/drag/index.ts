import {
  MIN_FLOAT_HEIGHT,
  MIN_FLOAT_WIDTH,
  applyDrop,
  floatAtRect,
  floatingStackMembers,
  splitFloating,
  stackFloatingOnto,
  unstackFloating,
  type FloatingSplitSide,
  type DropTarget,
  type FloatingRect,
  type LayoutBounds,
} from "../../../../layout/pane-manager";
import type { DesktopDockPreviewState } from "../../../../types/desktop-window";
import type { LayoutConfig } from "../../../../types/config";
import { PANE_HEADER_ACTION, PANE_HEADER_CLOSE, PANE_HEADER_HELP, PANE_HEADER_RESTORE } from "../../pane/header";

/** A release onto a floating window: a tab of it, or half of its rect beside it. */
type FloatDrop =
  | { type: "tab"; targetId: string }
  | { type: "split"; targetId: string; side: FloatingSplitSide };

/** Where a release lands a pane on the move, outlined while it would. */
export type DragPreview =
  | {
    /** A place in the layout: a split, a tab, or along a whole edge. */
    kind: "dock";
    target: DropTarget;
    rect: LayoutBounds;
  }
  | {
    /** On a floating window: a tab of it, or half of it. */
    kind: "float";
    drop: FloatDrop;
    rect: LayoutBounds;
  };

/**
 * What a pane move takes: a pane in the layout (drawn as an outline until it
 * lands), a floating window with every tab of its stack, or one tab pulled
 * out of a floating stack (an outline too, the stack staying where it is).
 */
export type PaneDragMode = "docked" | "floating" | "tab";

export interface PaneDragRectState {
  mode: PaneDragMode;
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
function freePaneDragRect(
  drag: PaneDragRectState,
  baseRect: FloatingRect,
  pointerX: number,
  pointerY: number,
  totalWidth: number,
  totalHeight: number,
): FloatingRect {
  if (drag.mode !== "floating") {
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
  mode: PaneDragMode = "floating",
): LayoutConfig {
  // A floating stack moved by its title bar lands whole: its other tabs follow as tabs of the one moved.
  const others = mode === "floating"
    ? floatingStackMembers(layout.floating, paneId).map((entry) => entry.instanceId).filter((id) => id !== paneId)
    : [];
  if (dockPreview?.kind === "dock") {
    let next = applyDrop(layout, paneId, dockPreview.target);
    for (const id of others) next = applyDrop(next, id, { kind: "tab", targetId: paneId });
    return next;
  }
  if (dockPreview?.kind === "float") {
    const { drop } = dockPreview;
    if (drop.type === "tab") {
      let next = layout;
      for (const id of others) next = stackFloatingOnto(next, id, drop.targetId);
      return stackFloatingOnto(next, paneId, drop.targetId);
    }
    let next = splitFloating(layout, paneId, drop.targetId, drop.side);
    for (const id of others) next = stackFloatingOnto(next, id, paneId);
    return next;
  }
  // Anywhere else it floats where it is drawn: a tab pulled out of a
  // floating stack on its own, a stack moved by its title bar whole.
  const from = mode === "tab" ? unstackFloating(layout, paneId) : layout;
  return floatAtRect(from, paneId, previewRect);
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
