import { useCallback } from "react";
import {
  floatAtRect,
  getRememberedFloatingRect,
  resizeSplitAtPath,
  simulateDrop,
  type DockGeometryOptions,
  type DockLeafLayout,
  type DropTarget,
  type LayoutBounds,
  type ResolvedPane,
} from "../../../plugins/pane-manager";
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
    dividerPreviewRef,
    dockPreviewRef,
    dragRef,
    setDragCursor,
    updateDividerPreview,
    updateDockPreview,
    updateDragFloatingRect,
  } = dragRuntime;

  return useCallback((event: ShellMouseEvent) => {
    const shellY = event.y - appHeaderHeight;
    const preciseX = event.preciseX ?? event.x;
    const preciseShellY = (event.preciseY ?? event.y) - appHeaderHeight;
    const hitX = precisePointer ? preciseX : event.x;
    const hitShellY = precisePointer ? preciseShellY : shellY;
    const dragThreshold = precisePointer ? PRECISE_PANE_DRAG_THRESHOLD : PANE_DRAG_THRESHOLD;
    const drag = dragRef.current;
    if (!drag) return;
    const baseLayout = windowMode?.previewLayout ?? visibleLayout;

    if (event.type === "drag") {
      if (drag.type === "divider") {
        const total = drag.axis === "horizontal" ? drag.bounds.width : drag.bounds.height;
        const delta = drag.axis === "horizontal" ? preciseX - drag.startX : preciseShellY - drag.startY;
        const nextRatio = Math.max(0.1, Math.min(0.9, drag.startRatio + (delta / Math.max(1, total))));
        const nextRect = resolveDividerPreviewRect(drag.axis, drag.bounds, nextRatio, nativePaneChrome === true);
        updateDividerPreview({ pathKey: drag.path.join("."), rect: nextRect, ratio: nextRatio });
      } else if (drag.type === "pane-drag") {
        if (!isMeaningfulPaneDrag(drag.startX, drag.startY, preciseX, preciseShellY, dragThreshold)) {
          updateDockPreview(null);
          setDragCursor(null);
          if (drag.mode === "floating") {
            updateDragFloatingRect({ paneId: drag.paneId, rect: drag.origRect });
          }
          event.stopPropagation();
          event.preventDefault();
          return;
        }

        const pane = paneMap.get(drag.paneId);
        const baseRect = drag.mode === "docked"
          ? getRememberedFloatingRect(baseLayout, drag.paneId, width, contentHeight, pane?.def)
          : drag.origRect;
        const nextRect = resolvePaneDragFloatingRect(drag, baseRect, preciseX, preciseShellY, width, contentHeight);
        updateDragFloatingRect({ paneId: drag.paneId, rect: nextRect });
        setDragCursor({ x: hitX, y: hitShellY });

        const hoveredOverlay = resolveHoverOverlay(hitX, hitShellY, dockLeafLayouts, drag.paneId);
        if (hoveredOverlay) {
          const hoveredCell = hoveredOverlay.cells.find((cell) => pointInRect(cell.rect, hitX, hitShellY));
          if (hoveredCell) {
            const target: DropTarget = { kind: "leaf", targetId: hoveredOverlay.targetId, position: hoveredCell.position };
            const simulation = simulateDrop(baseLayout, drag.paneId, target, bounds, dockGeometryOptions);
            if (simulation.previewRect) {
              updateDockPreview({ kind: "dock", target, rect: simulation.previewRect });
            } else {
              updateDockPreview(null);
            }
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
        const preview = dividerPreviewRef.current;
        if (preview) {
          const nextLayout = resizeSplitAtPath(baseLayout, drag.path, preview.ratio);
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
          setDragCursor(null);
          updateDragFloatingRect(null);
        } else {
          const pane = paneMap.get(drag.paneId);
          const baseRect = drag.mode === "docked"
            ? getRememberedFloatingRect(baseLayout, drag.paneId, width, contentHeight, pane?.def)
            : drag.origRect;
          const releaseRect = resolvePaneDragFloatingRect(drag, baseRect, preciseX, preciseShellY, width, contentHeight);
          const nextLayout = finalizePaneDragRelease(baseLayout, drag.paneId, releaseRect, dockPreviewRef.current);
          if (windowMode) {
            updateWindowModePreviewLayout(nextLayout, drag.paneId);
          } else {
            persistLayout(nextLayout);
          }
          focusPane(drag.paneId);
          updateDockPreview(null);
          setDragCursor(null);
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
        setDragCursor(null);
      }
      dragRef.current = null;
      event.stopPropagation();
      event.preventDefault();
    }
  }, [
    appHeaderHeight,
    bounds,
    contentHeight,
    dockGeometryOptions,
    dividerPreviewRef,
    dockLeafLayouts,
    dockPreviewRef,
    dragRef,
    focusPane,
    nativePaneChrome,
    paneMap,
    persistLayout,
    precisePointer,
    setDragCursor,
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
