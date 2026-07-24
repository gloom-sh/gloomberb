import {
  getDockLeafLayouts,
  getDockResizeTargets,
  simulateDrop,
  type DockGeometryOptions,
  type DropTarget,
  type FloatingRect,
  type FloatingResizeCorner,
  type LayoutBounds,
} from "../../../plugins/pane-manager";
import {
  normalizeWindowEditFocus,
  pathKey,
  type WindowEditDockMovePosition,
  type WindowEditState,
} from "./mode";

export interface WindowEditDockMovePreview {
  targetId: string;
  position: WindowEditDockMovePosition;
  rect: LayoutBounds;
}

function dockMovePositionLabel(position: WindowEditDockMovePosition): string {
  switch (position) {
    case "left":
      return "left";
    case "right":
      return "right";
    case "above":
      return "above";
    case "below":
      return "below";
  }
}

function dropPositionFromDockMovePosition(position: WindowEditDockMovePosition): Extract<DropTarget, { kind: "leaf" }>["position"] {
  return position === "above" ? "top" : position === "below" ? "bottom" : position;
}

function leafDropTarget(targetId: string, position: WindowEditDockMovePosition): DropTarget {
  return {
    kind: "leaf",
    targetId,
    position: dropPositionFromDockMovePosition(position),
  };
}

function windowEditLabel(state: WindowEditState, bounds: LayoutBounds, dockGeometryOptions: DockGeometryOptions): string {
  const focus = normalizeWindowEditFocus(state.focus, state.previewLayout, state.paneId, state.mode, bounds, dockGeometryOptions);
  if (state.mode === "move") return "WINDOW MOVE";
  if (focus.kind === "floating-resize") return `WINDOW RESIZE ${focus.corner}`;
  if (focus.kind !== "dock-resize") return "WINDOW RESIZE no handles";
  const targets = getDockResizeTargets(state.previewLayout, state.paneId, bounds, dockGeometryOptions);
  const index = targets.findIndex((target) => pathKey(target.path) === focus.pathKey);
  return `WINDOW RESIZE divider ${Math.max(1, index + 1)}/${Math.max(1, targets.length)}`;
}

export function windowEditStatusLine(
  state: WindowEditState,
  title: string,
  bounds: LayoutBounds,
  dockGeometryOptions: DockGeometryOptions,
  targetTitle?: string,
): string {
  const target = state.mode === "move" && state.focus.kind === "dock-move" && targetTitle
    ? ` -> ${targetTitle} ${dockMovePositionLabel(state.focus.position)}`
    : "";
  const notice = state.notice ? ` · ${state.notice}` : "";
  return `${windowEditLabel(state, bounds, dockGeometryOptions)}${notice} · ${title}${target}`;
}

export function windowEditHelpText(state: WindowEditState): string {
  if (state.mode === "move") {
    if (state.focus.kind === "dock-move") {
      return "arrows/hjkl choose side  Tab/w target  m window  d float  r resize  Enter commit/exit  Esc exit/cancel";
    }
    return "Tab/w window  d dock/float  r resize  arrows/hjkl target/move  Shift fast  Enter commit/exit  Esc exit/cancel";
  }
  if (state.focus.kind === "floating-resize") {
    return "Tab corner  w window  m move  arrows/hjkl resize  Shift fast  Enter commit/exit  Esc exit/cancel";
  }
  return "arrows/hjkl move divider  Tab divider  w window  m move  Shift fast  Enter commit/exit  Esc exit/cancel";
}

export function resolveWindowEditDockMovePreview(
  state: WindowEditState | null,
  bounds: LayoutBounds,
  dockGeometryOptions: DockGeometryOptions,
): WindowEditDockMovePreview | null {
  if (!state || state.mode !== "move" || state.focus.kind !== "dock-move") return null;
  const focus = state.focus;
  const leaves = getDockLeafLayouts(state.previewLayout, bounds, dockGeometryOptions);
  const selectedDocked = leaves.some((leaf) => leaf.instanceId === state.paneId);
  const targetDocked = leaves.some((leaf) => leaf.instanceId === focus.targetId && leaf.instanceId !== state.paneId);
  if (!selectedDocked || !targetDocked) return null;

  const simulation = simulateDrop(
    state.previewLayout,
    state.paneId,
    leafDropTarget(focus.targetId, focus.position),
    bounds,
    dockGeometryOptions,
  );
  if (!simulation.previewRect) return null;
  return {
    targetId: focus.targetId,
    position: focus.position,
    rect: simulation.previewRect,
  };
}

export function getFloatingResizeCornerPosition(rect: FloatingRect, corner: FloatingResizeCorner): { x: number; y: number; marker: string } {
  switch (corner) {
    case "top-left":
      return { x: rect.x, y: rect.y, marker: "◤" };
    case "top":
      return { x: rect.x + Math.floor(rect.width / 2), y: rect.y, marker: "┬" };
    case "top-right":
      return { x: rect.x + rect.width - 1, y: rect.y, marker: "◥" };
    case "right":
      return { x: rect.x + rect.width - 1, y: rect.y + Math.floor(rect.height / 2), marker: "┤" };
    case "bottom":
      return { x: rect.x + Math.floor(rect.width / 2), y: rect.y + rect.height - 1, marker: "┴" };
    case "bottom-left":
      return { x: rect.x, y: rect.y + rect.height - 1, marker: "◣" };
    case "bottom-right":
      return { x: rect.x + rect.width - 1, y: rect.y + rect.height - 1, marker: "◢" };
    case "left":
      return { x: rect.x, y: rect.y + Math.floor(rect.height / 2), marker: "├" };
  }
}
