import { useCallback, useRef } from "react";
import {
  floatAtRect,
  getRememberedFloatingRect,
  resizeSplitAtPath,
  simulateDrop,
  type DockGeometryOptions,
  type DockLeafLayout,
  type DropTarget,
  type FloatingRect,
  type LayoutBounds,
  type ResolvedPane,
} from "../../../layout/pane-manager";
import type { LayoutConfig } from "../../../types/config";
import {
  finalizePaneDragRelease,
  isMeaningfulPaneDrag,
  makeSnapGuides,
  PANE_DRAG_THRESHOLD,
  pointInRect,
  PRECISE_PANE_DRAG_THRESHOLD,
  resolveDividerPreviewRect,
  resolveFloatResizeRect,
  resolveHoverOverlay,
  resolvePaneDragFloatingRect,
  resolveSnapGuide,
  type DragPreview,
} from "./drag";
import type { ShellDragRuntimeState, ShellMouseEvent } from "./drag/runtime";
import type { WindowEditState } from "../window-edit/mode";

interface UseShellActiveDragOptions {
  appHeaderHeight: number;
  bounds: LayoutBounds;
  contentHeight: number;
  dockGeometryOptions: DockGeometryOptions;
  dockLeafLayouts: DockLeafLayout[];
  dragRuntime: ShellDragRuntimeState;
  focusPane: (paneId: string) => void;
  nativePaneChrome: boolean;
  paneMap: Map<string, ResolvedPane>;
  persistLayout: (nextLayout: LayoutConfig, options?: { pushHistory?: boolean }) => void;
  precisePointer: boolean | undefined;
  snapGuides: ReturnType<typeof makeSnapGuides>;
  updateWindowModePreviewLayout: (nextLayout: LayoutConfig, paneId?: string) => void;
  visibleLayout: LayoutConfig;
  width: number;
  windowMode: WindowEditState | null;
}

export function useShellActiveDrag({
  appHeaderHeight,
  bounds,
  contentHeight,
  dockGeometryOptions,
  dockLeafLayouts,
  dragRuntime,
  focusPane,
  nativePaneChrome,
  paneMap,
  persistLayout,
  precisePointer,
  snapGuides,
  updateWindowModePreviewLayout,
  visibleLayout,
  width,
  windowMode,
}: UseShellActiveDragOptions) {
  const {
    cancelActiveDrag,
    dragRef,
    live,
    setHoverTarget,
    updateDividerPreview,
    updateDockPreview,
    updateDragFloatingRect,
  } = dragRuntime;
  // What one drag keeps between moves: a docked pane's floating size, and the
  // last drop it simulated, so a move over the same target computes nothing.
  const memoRef = useRef<{
    drag: unknown;
    baseRect: FloatingRect | null;
    dropKey: string | null;
    drop: DragPreview | null;
  }>({ drag: null, baseRect: null, dropKey: null, drop: null });

  return useCallback((event: ShellMouseEvent) => {
    const shellY = event.y - appHeaderHeight;
    const preciseX = event.preciseX ?? event.x;
    const preciseShellY = (event.preciseY ?? event.y) - appHeaderHeight;
    // Drawn a moment ahead where the host predicts the pointer; hit tests and
    // the release use where it is.
    const drawX = event.predictedX ?? preciseX;
    const drawShellY = event.predictedY != null ? event.predictedY - appHeaderHeight : preciseShellY;
    const hitX = precisePointer ? preciseX : event.x;
    const hitShellY = precisePointer ? preciseShellY : shellY;
    const dragThreshold = precisePointer ? PRECISE_PANE_DRAG_THRESHOLD : PANE_DRAG_THRESHOLD;
    const drag = dragRef.current;
    if (!drag) return;
    const baseLayout = windowMode?.previewLayout ?? visibleLayout;
    const memo = memoRef.current;
    if (memo.drag !== drag) {
      memo.drag = drag;
      memo.baseRect = null;
      memo.dropKey = null;
      memo.drop = null;
    }
    const dividerRatioAt = (x: number, y: number) => {
      if (drag.type !== "divider") return 0;
      const total = drag.axis === "horizontal" ? drag.bounds.width : drag.bounds.height;
      const delta = drag.axis === "horizontal" ? x - drag.startX : y - drag.startY;
      return Math.max(0.1, Math.min(0.9, drag.startRatio + (delta / Math.max(1, total))));
    };
    const dragBaseRect = () => {
      if (drag.type !== "pane-drag") return null;
      if (drag.mode === "floating") return drag.origRect;
      memo.baseRect ??= getRememberedFloatingRect(baseLayout, drag.paneId, width, contentHeight, paneMap.get(drag.paneId)?.def);
      return memo.baseRect;
    };

    if (event.type === "drag-cancel") {
      // The window lost focus or the system took the pointer: put everything back.
      cancelActiveDrag();
      event.stopPropagation();
      event.preventDefault();
      return;
    }

    if (event.type === "drag") {
      if (drag.type === "divider") {
        const nextRatio = dividerRatioAt(drawX, drawShellY);
        const nextRect = resolveDividerPreviewRect(drag.axis, drag.bounds, nextRatio, nativePaneChrome === true);
        updateDividerPreview({ pathKey: drag.path.join("."), rect: nextRect, ratio: nextRatio });
      } else if (drag.type === "pane-drag") {
        if (!isMeaningfulPaneDrag(drag.startX, drag.startY, preciseX, preciseShellY, dragThreshold)) {
          updateDockPreview(null);
          setHoverTarget(null);
          if (drag.mode === "floating") {
            updateDragFloatingRect({ paneId: drag.paneId, rect: drag.origRect });
          }
          event.stopPropagation();
          event.preventDefault();
          return;
        }

        const nextRect = resolvePaneDragFloatingRect(drag, dragBaseRect()!, drawX, drawShellY, width, contentHeight);
        updateDragFloatingRect({ paneId: drag.paneId, rect: nextRect });

        const hoveredOverlay = resolveHoverOverlay(hitX, hitShellY, dockLeafLayouts, drag.paneId);
        setHoverTarget(hoveredOverlay?.targetId ?? null);
        if (hoveredOverlay) {
          const hoveredCell = hoveredOverlay.cells.find((cell) => pointInRect(cell.rect, hitX, hitShellY));
          if (hoveredCell) {
            const dropKey = `${hoveredOverlay.targetId}:${hoveredCell.position}`;
            if (memo.dropKey !== dropKey) {
              const target: DropTarget = { kind: "leaf", targetId: hoveredOverlay.targetId, position: hoveredCell.position };
              const simulation = simulateDrop(baseLayout, drag.paneId, target, bounds, dockGeometryOptions);
              memo.dropKey = dropKey;
              memo.drop = simulation.previewRect ? { kind: "dock", target, rect: simulation.previewRect } : null;
            }
            updateDockPreview(memo.drop);
          } else {
            updateDockPreview(null);
          }
        } else {
          const snapGuide = resolveSnapGuide(hitX, hitShellY, snapGuides);
          updateDockPreview(snapGuide ? { kind: "snap", position: snapGuide.position, rect: snapGuide.previewRect } : null);
        }
      } else if (drag.type === "float-resize") {
        updateDragFloatingRect({
          paneId: drag.paneId,
          rect: resolveFloatResizeRect(drag, preciseX, preciseShellY, width, contentHeight),
        });
      }
      event.stopPropagation();
      event.preventDefault();
      return;
    }

    if (event.type === "up" || event.type === "drag-end") {
      if (drag.type === "divider") {
        if (live.get().divider) {
          const nextLayout = resizeSplitAtPath(baseLayout, drag.path, dividerRatioAt(preciseX, preciseShellY));
          if (windowMode) {
            updateWindowModePreviewLayout(nextLayout);
          } else {
            persistLayout(nextLayout);
          }
        }
        updateDividerPreview(null);
      } else if (drag.type === "pane-drag") {
        const movedEnough = isMeaningfulPaneDrag(drag.startX, drag.startY, preciseX, preciseShellY, dragThreshold);
        if (!movedEnough) {
          updateDockPreview(null);
          setHoverTarget(null);
          updateDragFloatingRect(null);
        } else {
          const releaseRect = resolvePaneDragFloatingRect(drag, dragBaseRect()!, preciseX, preciseShellY, width, contentHeight);
          const nextLayout = finalizePaneDragRelease(baseLayout, drag.paneId, releaseRect, live.get().dockPreview);
          if (windowMode) {
            updateWindowModePreviewLayout(nextLayout, drag.paneId);
          } else {
            persistLayout(nextLayout);
          }
          focusPane(drag.paneId);
          updateDockPreview(null);
          setHoverTarget(null);
          updateDragFloatingRect(null);
        }
      } else if (drag.type === "float-resize") {
        const releaseRect = resolveFloatResizeRect(drag, preciseX, preciseShellY, width, contentHeight);
        const nextLayout = floatAtRect(baseLayout, drag.paneId, releaseRect);
        if (windowMode) {
          updateWindowModePreviewLayout(nextLayout, drag.paneId);
        } else {
          persistLayout(nextLayout);
        }
        updateDragFloatingRect(null);
        setHoverTarget(null);
      }
      dragRef.current = null;
      live.set({ paneDrag: null });
      event.stopPropagation();
      event.preventDefault();
    }
  }, [
    appHeaderHeight,
    bounds,
    cancelActiveDrag,
    contentHeight,
    dockGeometryOptions,
    dockLeafLayouts,
    dragRef,
    focusPane,
    live,
    nativePaneChrome,
    paneMap,
    persistLayout,
    precisePointer,
    setHoverTarget,
    snapGuides,
    updateDividerPreview,
    updateDockPreview,
    updateDragFloatingRect,
    updateWindowModePreviewLayout,
    visibleLayout,
    windowMode,
    width,
  ]);
}
