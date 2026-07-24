import {
  applyDrop,
  bringToFront,
  getDockLeafLayouts,
  getDockResizeTargets,
  moveFloatingPane,
  resizeFloatingPaneFromCorner,
  resizeSplitAtPath,
  type DockGeometryOptions,
  type DockLeafLayout,
  type DockResizeTarget,
  type DropTarget,
  type FloatingResizeCorner,
  type LayoutBounds,
} from "../../../plugins/pane-manager";
import type { WindowEditMode } from "../../../plugins/registry";
import type { LayoutConfig } from "../../../types/config";

export type WindowEditDockMovePosition = "left" | "right" | "above" | "below";

export type WindowEditFocus =
  | { kind: "move" }
  | { kind: "dock-move"; targetId: string; position: WindowEditDockMovePosition }
  | { kind: "floating-resize"; corner: FloatingResizeCorner }
  | { kind: "dock-resize"; pathKey: string };

export interface WindowEditState {
  paneId: string;
  previewLayout: LayoutConfig;
  mode: WindowEditMode;
  focus: WindowEditFocus;
  dirty: boolean;
  notice?: string;
}

export type WindowEditDirection = "left" | "right" | "up" | "down";

const FLOATING_RESIZE_CORNERS: FloatingResizeCorner[] = [
  "top-left",
  "top",
  "top-right",
  "right",
  "bottom-right",
  "bottom",
  "bottom-left",
  "left",
];
const WINDOW_EDIT_MOVE_STEP = { x: 2, y: 1 };
const WINDOW_EDIT_FAST_STEP = { x: 10, y: 5 };

export function directionFromWindowEditKey(event: { name?: string; key?: string }): WindowEditDirection | null {
  const name = (event.name ?? event.key ?? "").toLowerCase();
  if (name === "left" || name === "h") return "left";
  if (name === "right" || name === "l") return "right";
  if (name === "up" || name === "k") return "up";
  if (name === "down" || name === "j") return "down";
  return null;
}

function positionFromDirection(direction: WindowEditDirection): WindowEditDockMovePosition {
  switch (direction) {
    case "left":
      return "left";
    case "right":
      return "right";
    case "up":
      return "above";
    case "down":
      return "below";
  }
}

function dropPositionFromDockMovePosition(position: WindowEditDockMovePosition): Extract<DropTarget, { kind: "leaf" }>["position"] {
  return position === "above" ? "top" : position === "below" ? "bottom" : position;
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

function dockResizeAxisLabel(axis: DockResizeTarget["axis"]): string {
  return axis === "horizontal" ? "left/right" : "up/down";
}

export function pathKey(path: Array<0 | 1>): string {
  return path.join(".");
}

function dockLeafCenter(leaf: DockLeafLayout): { x: number; y: number } {
  return {
    x: leaf.rect.x + leaf.rect.width / 2,
    y: leaf.rect.y + leaf.rect.height / 2,
  };
}

function scoreDockMoveTarget(current: DockLeafLayout, candidate: DockLeafLayout, direction: WindowEditDirection): number | null {
  const currentCenter = dockLeafCenter(current);
  const candidateCenter = dockLeafCenter(candidate);

  if (direction === "left" && candidateCenter.x >= currentCenter.x) return null;
  if (direction === "right" && candidateCenter.x <= currentCenter.x) return null;
  if (direction === "up" && candidateCenter.y >= currentCenter.y) return null;
  if (direction === "down" && candidateCenter.y <= currentCenter.y) return null;

  const primaryDelta = direction === "left" || direction === "right"
    ? Math.abs(currentCenter.x - candidateCenter.x)
    : Math.abs(currentCenter.y - candidateCenter.y);
  const secondaryDelta = direction === "left" || direction === "right"
    ? Math.abs(currentCenter.y - candidateCenter.y)
    : Math.abs(currentCenter.x - candidateCenter.x);

  return primaryDelta * 1000 + secondaryDelta;
}

function getClosestDockMoveTarget(
  layout: LayoutConfig,
  paneId: string,
  direction: WindowEditDirection,
  bounds: LayoutBounds,
  dockGeometryOptions: DockGeometryOptions,
): DockLeafLayout | null {
  const leaves = getDockLeafLayouts(layout, bounds, dockGeometryOptions);
  const current = leaves.find((leaf) => leaf.instanceId === paneId);
  if (!current) return null;

  return leaves
    .filter((leaf) => leaf.instanceId !== paneId)
    .map((leaf) => ({ leaf, score: scoreDockMoveTarget(current, leaf, direction) }))
    .filter((entry): entry is { leaf: DockLeafLayout; score: number } => entry.score !== null)
    .sort((left, right) => left.score - right.score)[0]?.leaf ?? null;
}

function resolveDockMoveFocus(
  focus: WindowEditFocus,
  layout: LayoutConfig,
  paneId: string,
  direction: WindowEditDirection,
  bounds: LayoutBounds,
  dockGeometryOptions: DockGeometryOptions,
): WindowEditFocus | null {
  const position = positionFromDirection(direction);
  const leaves = getDockLeafLayouts(layout, bounds, dockGeometryOptions);
  const selectedDocked = leaves.some((leaf) => leaf.instanceId === paneId);
  if (!selectedDocked) return null;

  if (focus.kind === "dock-move"
    && focus.targetId !== paneId
    && leaves.some((leaf) => leaf.instanceId === focus.targetId)) {
    return { ...focus, position };
  }

  const target = getClosestDockMoveTarget(layout, paneId, direction, bounds, dockGeometryOptions);
  if (!target) return null;
  return { kind: "dock-move", targetId: target.instanceId, position };
}

function leafDropTarget(targetId: string, position: WindowEditDockMovePosition): DropTarget {
  return {
    kind: "leaf",
    targetId,
    position: dropPositionFromDockMovePosition(position),
  };
}

function getWindowEditFocusTargets(
  layout: LayoutConfig,
  paneId: string,
  mode: WindowEditMode,
  bounds: LayoutBounds,
  dockGeometryOptions: DockGeometryOptions,
): WindowEditFocus[] {
  if (mode === "move") return [{ kind: "move" }];

  if (layout.floating.some((entry) => entry.instanceId === paneId)) {
    return FLOATING_RESIZE_CORNERS.map((corner) => ({ kind: "floating-resize" as const, corner }));
  }

  const resizeTargets = getDockResizeTargets(layout, paneId, bounds, dockGeometryOptions);
  return resizeTargets.map((target) => ({ kind: "dock-resize" as const, pathKey: pathKey(target.path) }));
}

function sameWindowEditFocus(left: WindowEditFocus, right: WindowEditFocus): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "move" || right.kind === "move") return true;
  if (left.kind === "dock-move" && right.kind === "dock-move") {
    return left.targetId === right.targetId && left.position === right.position;
  }
  if (left.kind === "floating-resize" && right.kind === "floating-resize") return left.corner === right.corner;
  if (left.kind === "dock-resize" && right.kind === "dock-resize") return left.pathKey === right.pathKey;
  return false;
}

export function normalizeWindowEditFocus(
  focus: WindowEditFocus,
  layout: LayoutConfig,
  paneId: string,
  mode: WindowEditMode,
  bounds: LayoutBounds,
  dockGeometryOptions: DockGeometryOptions,
): WindowEditFocus {
  if (mode === "move") {
    if (focus.kind === "dock-move"
      && !layout.floating.some((entry) => entry.instanceId === paneId)
      && getDockLeafLayouts(layout, bounds, dockGeometryOptions).some((leaf) => leaf.instanceId === focus.targetId && leaf.instanceId !== paneId)) {
      return focus;
    }
    return { kind: "move" };
  }

  const targets = getWindowEditFocusTargets(layout, paneId, mode, bounds, dockGeometryOptions);
  return targets.find((target) => sameWindowEditFocus(target, focus)) ?? targets[0] ?? { kind: "move" };
}

export function cycleWindowEditFocus(
  focus: WindowEditFocus,
  layout: LayoutConfig,
  paneId: string,
  mode: WindowEditMode,
  bounds: LayoutBounds,
  dockGeometryOptions: DockGeometryOptions,
  delta: 1 | -1,
): WindowEditFocus {
  const targets = getWindowEditFocusTargets(layout, paneId, mode, bounds, dockGeometryOptions);
  if (targets.length === 0) return { kind: "move" };
  const currentIndex = Math.max(0, targets.findIndex((target) => sameWindowEditFocus(target, focus)));
  return targets[(currentIndex + delta + targets.length) % targets.length] ?? targets[0]!;
}

function getWindowEditDockPaneIds(
  layout: LayoutConfig,
  bounds: LayoutBounds,
  dockGeometryOptions: DockGeometryOptions,
): string[] {
  return getDockLeafLayouts(layout, bounds, dockGeometryOptions).map((entry) => entry.instanceId);
}

export function getWindowEditPaneIds(
  layout: LayoutConfig,
  bounds: LayoutBounds,
  dockGeometryOptions: DockGeometryOptions,
): string[] {
  const dockedIds = getWindowEditDockPaneIds(layout, bounds, dockGeometryOptions);
  const floatingIds = layout.floating.map((entry) => entry.instanceId);
  return [...dockedIds, ...floatingIds];
}

export function cycleWindowEditTarget(
  state: WindowEditState,
  bounds: LayoutBounds,
  dockGeometryOptions: DockGeometryOptions,
  delta: 1 | -1,
): WindowEditState {
  if (state.mode !== "move" || state.focus.kind !== "dock-move") {
    return state;
  }

  const targetIds = getWindowEditDockPaneIds(state.previewLayout, bounds, dockGeometryOptions)
    .filter((paneId) => paneId !== state.paneId);
  if (targetIds.length === 0) {
    return {
      ...state,
      focus: normalizeWindowEditFocus({ kind: "move" }, state.previewLayout, state.paneId, state.mode, bounds, dockGeometryOptions),
    };
  }

  const currentIndex = targetIds.indexOf(state.focus.targetId);
  const startIndex = currentIndex >= 0
    ? currentIndex
    : delta === 1
      ? -1
      : 0;
  const targetId = targetIds[(startIndex + delta + targetIds.length) % targetIds.length] ?? targetIds[0]!;
  return {
    ...state,
    focus: normalizeWindowEditFocus({ ...state.focus, targetId }, state.previewLayout, state.paneId, state.mode, bounds, dockGeometryOptions),
    notice: undefined,
  };
}

export function raiseWindowEditPane(layout: LayoutConfig, paneId: string): LayoutConfig {
  const floating = layout.floating.find((entry) => entry.instanceId === paneId);
  if (!floating) return layout;
  const currentZ = floating.zIndex ?? 50;
  const covered = layout.floating.some((entry) => entry.instanceId !== paneId && (entry.zIndex ?? 50) >= currentZ);
  return covered ? bringToFront(layout, paneId) : layout;
}

export function cycleWindowEditPane(
  state: WindowEditState,
  paneIds: string[],
  bounds: LayoutBounds,
  dockGeometryOptions: DockGeometryOptions,
  delta: 1 | -1,
): WindowEditState {
  if (paneIds.length === 0) return state;
  const currentIndex = Math.max(0, paneIds.indexOf(state.paneId));
  const paneId = paneIds[(currentIndex + delta + paneIds.length) % paneIds.length] ?? state.paneId;
  const previewLayout = raiseWindowEditPane(state.previewLayout, paneId);
  const preferredFocus: WindowEditFocus = state.mode === "move" ? { kind: "move" } : state.focus;
  return {
    ...state,
    paneId,
    previewLayout,
    focus: normalizeWindowEditFocus(preferredFocus, previewLayout, paneId, state.mode, bounds, dockGeometryOptions),
    dirty: state.dirty || previewLayout !== state.previewLayout,
    notice: undefined,
  };
}

export function setWindowEditPane(
  state: WindowEditState,
  paneId: string,
  bounds: LayoutBounds,
  dockGeometryOptions: DockGeometryOptions,
): WindowEditState {
  const previewLayout = raiseWindowEditPane(state.previewLayout, paneId);
  return {
    ...state,
    paneId,
    previewLayout,
    focus: normalizeWindowEditFocus(state.mode === "move" ? { kind: "move" } : state.focus, previewLayout, paneId, state.mode, bounds, dockGeometryOptions),
    dirty: state.dirty || previewLayout !== state.previewLayout,
    notice: undefined,
  };
}

export function setWindowEditMode(
  state: WindowEditState,
  mode: WindowEditMode,
  bounds: LayoutBounds,
  dockGeometryOptions: DockGeometryOptions,
): WindowEditState {
  const preferredFocus: WindowEditFocus = mode === "move" ? { kind: "move" } : state.focus;
  return {
    ...state,
    mode,
    focus: normalizeWindowEditFocus(preferredFocus, state.previewLayout, state.paneId, mode, bounds, dockGeometryOptions),
    notice: undefined,
  };
}

function getDockResizeTargetForFocus(
  layout: LayoutConfig,
  paneId: string,
  focus: WindowEditFocus,
  bounds: LayoutBounds,
  dockGeometryOptions: DockGeometryOptions,
): DockResizeTarget | null {
  const targets = getDockResizeTargets(layout, paneId, bounds, dockGeometryOptions);
  if (focus.kind !== "dock-resize") return targets[0] ?? null;
  return targets.find((target) => pathKey(target.path) === focus.pathKey) ?? targets[0] ?? null;
}

function resizeDockPaneDividerByDirection(
  layout: LayoutConfig,
  target: DockResizeTarget,
  direction: WindowEditDirection,
  step: { x: number; y: number },
): LayoutConfig | null {
  if (target.axis === "horizontal") {
    if (direction !== "left" && direction !== "right") return null;
    const delta = step.x / Math.max(1, target.bounds.width);
    return resizeSplitAtPath(layout, target.path, target.ratio + (direction === "right" ? delta : -delta));
  }

  if (direction !== "up" && direction !== "down") return null;
  const delta = step.y / Math.max(1, target.bounds.height);
  return resizeSplitAtPath(layout, target.path, target.ratio + (direction === "down" ? delta : -delta));
}

export function resolveWindowEditCommitLayout(
  state: WindowEditState,
  bounds: LayoutBounds,
  dockGeometryOptions: DockGeometryOptions,
): LayoutConfig {
  if (state.mode !== "move" || state.focus.kind !== "dock-move") return state.previewLayout;

  const focus = state.focus;
  const leaves = getDockLeafLayouts(state.previewLayout, bounds, dockGeometryOptions);
  const selectedDocked = leaves.some((leaf) => leaf.instanceId === state.paneId);
  const targetDocked = leaves.some((leaf) => leaf.instanceId === focus.targetId && leaf.instanceId !== state.paneId);
  if (!selectedDocked || !targetDocked) return state.previewLayout;

  return applyDrop(state.previewLayout, state.paneId, leafDropTarget(focus.targetId, focus.position));
}

export function windowEditHasPendingCommit(
  state: WindowEditState,
  bounds: LayoutBounds,
  dockGeometryOptions: DockGeometryOptions,
): boolean {
  return state.dirty || resolveWindowEditCommitLayout(state, bounds, dockGeometryOptions) !== state.previewLayout;
}

export function applyWindowEditDirection(
  state: WindowEditState,
  direction: WindowEditDirection,
  fast: boolean,
  bounds: LayoutBounds,
  dockGeometryOptions: DockGeometryOptions,
): WindowEditState {
  const step = fast ? WINDOW_EDIT_FAST_STEP : WINDOW_EDIT_MOVE_STEP;
  const focus = normalizeWindowEditFocus(state.focus, state.previewLayout, state.paneId, state.mode, bounds, dockGeometryOptions);
  let nextLayout = state.previewLayout;

  if (state.mode === "move") {
    if (nextLayout.floating.some((entry) => entry.instanceId === state.paneId)) {
      const deltaX = direction === "left" ? -step.x : direction === "right" ? step.x : 0;
      const deltaY = direction === "up" ? -step.y : direction === "down" ? step.y : 0;
      nextLayout = moveFloatingPane(nextLayout, state.paneId, deltaX, deltaY, bounds);
    } else {
      const nextMoveFocus = resolveDockMoveFocus(focus, nextLayout, state.paneId, direction, bounds, dockGeometryOptions);
      if (!nextMoveFocus) {
        return {
          ...state,
          focus,
          notice: `No pane ${dockMovePositionLabel(positionFromDirection(direction))}`,
        };
      }
      return {
        ...state,
        focus: nextMoveFocus,
        notice: undefined,
      };
    }
  } else if (focus.kind === "floating-resize") {
    const deltaX = direction === "left" ? -step.x : direction === "right" ? step.x : 0;
    const deltaY = direction === "up" ? -step.y : direction === "down" ? step.y : 0;
    nextLayout = resizeFloatingPaneFromCorner(nextLayout, state.paneId, focus.corner, deltaX, deltaY, bounds);
  } else {
    const target = getDockResizeTargetForFocus(nextLayout, state.paneId, focus, bounds, dockGeometryOptions);
    if (target) {
      const resizedLayout = resizeDockPaneDividerByDirection(nextLayout, target, direction, step);
      if (!resizedLayout) {
        return {
          ...state,
          focus: normalizeWindowEditFocus({ kind: "dock-resize", pathKey: pathKey(target.path) }, nextLayout, state.paneId, state.mode, bounds, dockGeometryOptions),
          notice: `Use ${dockResizeAxisLabel(target.axis)} for selected divider`,
        };
      }
      nextLayout = resizedLayout;
      const nextFocus = normalizeWindowEditFocus({ kind: "dock-resize", pathKey: pathKey(target.path) }, nextLayout, state.paneId, state.mode, bounds, dockGeometryOptions);
      return {
        ...state,
        previewLayout: nextLayout,
        focus: nextFocus,
        dirty: state.dirty || nextLayout !== state.previewLayout,
        notice: undefined,
      };
    }

    return {
      ...state,
      focus,
      notice: "No divider to resize",
    };
  }

  const nextFocus = normalizeWindowEditFocus(focus, nextLayout, state.paneId, state.mode, bounds, dockGeometryOptions);
  return {
    ...state,
    previewLayout: nextLayout,
    focus: nextFocus,
    dirty: state.dirty || nextLayout !== state.previewLayout,
    notice: undefined,
  };
}
