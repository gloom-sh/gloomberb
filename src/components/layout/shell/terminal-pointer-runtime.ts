import { useCallback, type Dispatch, type SetStateAction } from "react";
import type {
  DockDividerLayout,
  DockLeafLayout,
  FloatingRect,
  LayoutBounds,
  ResolvedPane,
} from "../../../layout/pane-manager";
import {
  constrainFloatingRectToBounds,
  pointInRect,
  resolveHeaderHitAreas,
} from "./drag";
import type { ActionMenuState } from "./action-menu-overlay";
import type {
  ShellDragRuntimeState,
  ShellMouseEvent,
  VisibleFloatingPane,
} from "./drag/runtime";
import type { WindowEditState } from "../window-edit/mode";

interface UseShellTerminalPointerRuntimeOptions {
  appHeaderHeight: number;
  closePaneMenu: () => void;
  contentHeight: number;
  dockDividerLayouts: DockDividerLayout[];
  dockLeafLayouts: DockLeafLayout[];
  dragRuntime: ShellDragRuntimeState;
  focusPane: (paneId: string) => void;
  focusedPaneId: string | null;
  handleActiveDrag: (event: ShellMouseEvent) => void;
  handleFloatingClose: (paneId: string) => void;
  restoreFullscreen: () => void;
  menuState: ActionMenuState | null;
  openPaneMenu: (
    paneId: string,
    rect: LayoutBounds,
    event?: { preventDefault?: () => void; stopPropagation?: () => void },
  ) => void;
  paneMap: Map<string, ResolvedPane>;
  selectWindowModePane: (paneId: string) => void;
  setHoveredMenuItemId: Dispatch<SetStateAction<string | null>>;
  setMenuState: Dispatch<SetStateAction<ActionMenuState | null>>;
  transientFocusActive: boolean;
  visibleFloatingPanes: VisibleFloatingPane[];
  width: number;
  windowMode: WindowEditState | null;
}

function getVisibleFloatingRect(
  visibleRect: FloatingRect,
  paneId: string,
  dragFloatingRect: { paneId: string; rect: FloatingRect } | null,
  width: number,
  contentHeight: number,
): FloatingRect {
  return dragFloatingRect?.paneId === paneId
    ? constrainFloatingRectToBounds(dragFloatingRect.rect, width, contentHeight)
    : visibleRect;
}

function sortedFloatingPanes(visibleFloatingPanes: VisibleFloatingPane[]): VisibleFloatingPane[] {
  return [...visibleFloatingPanes].sort((a, b) => (b.pane.floating?.zIndex ?? 50) - (a.pane.floating?.zIndex ?? 50));
}

export function useShellTerminalPointerRuntime({
  appHeaderHeight,
  closePaneMenu,
  contentHeight,
  dockDividerLayouts,
  dockLeafLayouts,
  dragRuntime,
  focusPane,
  focusedPaneId,
  handleActiveDrag,
  handleFloatingClose,
  restoreFullscreen,
  menuState,
  openPaneMenu,
  paneMap,
  selectWindowModePane,
  setHoveredMenuItemId,
  setMenuState,
  transientFocusActive,
  visibleFloatingPanes,
  width,
  windowMode,
}: UseShellTerminalPointerRuntimeOptions) {
  const {
    live,
    startDrag,
    updateDividerPreview,
    updateDragFloatingRect,
  } = dragRuntime;

  return useCallback((event: ShellMouseEvent) => {
    const shellY = event.y - appHeaderHeight;
    const preciseX = event.preciseX ?? event.x;
    const preciseShellY = (event.preciseY ?? event.y) - appHeaderHeight;
    if (shellY < 0) return;
    if (windowMode) {
      if (event.type !== "down") {
        handleActiveDrag(event);
        event.stopPropagation();
        event.preventDefault();
        return;
      }

      if (menuState) {
        closePaneMenu();
      }

      for (const { pane, rect: visibleRect } of sortedFloatingPanes(visibleFloatingPanes)) {
        const paneId = pane.instance.instanceId;
        const rect = getVisibleFloatingRect(visibleRect, paneId, live.get().floating, width, contentHeight);
        if (!pointInRect({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }, event.x, shellY)) continue;

        const relativeX = event.x - rect.x;
        const relativeY = shellY - rect.y;
        selectWindowModePane(paneId);

        if (relativeX >= rect.width - 2 && relativeY >= rect.height - 1) {
          startDrag({
            type: "float-resize",
            paneId,
            startX: preciseX,
            startY: preciseShellY,
            origRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          });
          updateDragFloatingRect({ paneId, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
        }

        event.stopPropagation();
        event.preventDefault();
        return;
      }

      if (!transientFocusActive) {
        for (const divider of dockDividerLayouts) {
          if (!pointInRect(divider.rect, event.x, shellY)) continue;
          startDrag({
            type: "divider",
            path: divider.path,
            axis: divider.axis,
            startX: preciseX,
            startY: preciseShellY,
            startRatio: divider.ratio,
            bounds: divider.bounds,
          });
          updateDividerPreview({
            pathKey: divider.path.join("."),
            rect: divider.rect,
            ratio: divider.ratio,
          });
          event.stopPropagation();
          event.preventDefault();
          return;
        }
      }

      for (const leaf of dockLeafLayouts) {
        if (!pointInRect(leaf.rect, event.x, shellY)) continue;
        selectWindowModePane(leaf.instanceId);
        event.stopPropagation();
        event.preventDefault();
        return;
      }

      event.stopPropagation();
      event.preventDefault();
      return;
    }

    if (event.type === "down") {
      if (menuState) {
        setMenuState(null);
        setHoveredMenuItemId(null);
      }

      for (const { pane, rect: visibleRect } of sortedFloatingPanes(visibleFloatingPanes)) {
        const paneId = pane.instance.instanceId;
        const rect = getVisibleFloatingRect(visibleRect, paneId, live.get().floating, width, contentHeight);
        if (!pointInRect({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }, event.x, shellY)) continue;
        const relativeX = event.x - rect.x;
        const relativeY = shellY - rect.y;
        const isFocused = focusedPaneId === paneId;
        const headerAreas = resolveHeaderHitAreas(rect.width, {
          floating: true,
          focused: isFocused,
          fullscreen: transientFocusActive,
        });
        focusPane(paneId);
        if (event.button === 2 && relativeY === 0) {
          openPaneMenu(paneId, rect, event);
          return;
        }
        if (relativeY === 0 && headerAreas.closeStart != null && relativeX >= headerAreas.closeStart && relativeX < rect.width) {
          if (transientFocusActive) restoreFullscreen();
          else handleFloatingClose(paneId);
          event.stopPropagation();
          event.preventDefault();
          return;
        }
        if (relativeY === 0
          && headerAreas.actionStart != null
          && headerAreas.closeStart != null
          && relativeX >= headerAreas.actionStart
          && relativeX < headerAreas.closeStart) {
          openPaneMenu(paneId, rect, event);
          event.stopPropagation();
          event.preventDefault();
          return;
        }
        if (!transientFocusActive && relativeX >= rect.width - 2 && relativeY >= rect.height - 1) {
          startDrag({
            type: "float-resize",
            paneId,
            startX: preciseX,
            startY: preciseShellY,
            origRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          });
          updateDragFloatingRect({ paneId, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
          event.stopPropagation();
          event.preventDefault();
          return;
        }
        if (relativeY === 0 && transientFocusActive) {
          event.stopPropagation();
          event.preventDefault();
          return;
        }
        if (relativeY === 0) {
          startDrag({
            type: "pane-drag",
            paneId,
            mode: "floating",
            startX: preciseX,
            startY: preciseShellY,
            origRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          });
          updateDragFloatingRect({ paneId, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
          event.stopPropagation();
          event.preventDefault();
          return;
        }
        return;
      }

      for (const divider of dockDividerLayouts) {
        if (!pointInRect(divider.rect, event.x, shellY)) continue;
        startDrag({
          type: "divider",
          path: divider.path,
          axis: divider.axis,
          startX: preciseX,
          startY: preciseShellY,
          startRatio: divider.ratio,
          bounds: divider.bounds,
        });
        updateDividerPreview({
          pathKey: divider.path.join("."),
          rect: divider.rect,
          ratio: divider.ratio,
        });
        event.stopPropagation();
        event.preventDefault();
        return;
      }

      for (const leaf of dockLeafLayouts) {
        if (!pointInRect(leaf.rect, event.x, shellY)) continue;
        const pane = paneMap.get(leaf.instanceId);
        if (!pane) continue;
        const relativeX = event.x - leaf.rect.x;
        const relativeY = shellY - leaf.rect.y;
        const isFocused = focusedPaneId === leaf.instanceId;
        const headerAreas = resolveHeaderHitAreas(leaf.rect.width, {
          floating: false,
          focused: isFocused,
          fullscreen: transientFocusActive,
        });
        focusPane(leaf.instanceId);
        if (event.button === 2 && relativeY === 0) {
          openPaneMenu(leaf.instanceId, leaf.rect, event);
          return;
        }
        if (relativeY === 0
          && transientFocusActive
          && headerAreas.closeStart != null
          && relativeX >= headerAreas.closeStart) {
          restoreFullscreen();
          event.stopPropagation();
          event.preventDefault();
          return;
        }
        if (relativeY === 0
          && headerAreas.actionStart != null
          && relativeX >= headerAreas.actionStart
          && (headerAreas.closeStart == null || relativeX < headerAreas.closeStart)) {
          openPaneMenu(leaf.instanceId, leaf.rect, event);
          event.stopPropagation();
          event.preventDefault();
          return;
        }
        if (relativeY === 0 && transientFocusActive) {
          event.stopPropagation();
          event.preventDefault();
          return;
        }
        if (relativeY === 0) {
          startDrag({
            type: "pane-drag",
            paneId: leaf.instanceId,
            mode: "docked",
            startX: preciseX,
            startY: preciseShellY,
            origRect: { x: leaf.rect.x, y: leaf.rect.y, width: leaf.rect.width, height: leaf.rect.height },
          });
          event.stopPropagation();
          event.preventDefault();
          return;
        }
        return;
      }

      return;
    }

    handleActiveDrag(event);
  }, [
    appHeaderHeight,
    closePaneMenu,
    contentHeight,
    dockDividerLayouts,
    dockLeafLayouts,
    focusPane,
    focusedPaneId,
    handleActiveDrag,
    handleFloatingClose,
    live,
    restoreFullscreen,
    menuState,
    openPaneMenu,
    paneMap,
    selectWindowModePane,
    setHoveredMenuItemId,
    setMenuState,
    startDrag,
    transientFocusActive,
    updateDividerPreview,
    updateDragFloatingRect,
    visibleFloatingPanes,
    windowMode,
    width,
  ]);
}
