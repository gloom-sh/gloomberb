import { useCallback, type Dispatch, type SetStateAction } from "react";
import type {
  DockDividerLayout,
  DockLeafLayout,
  FloatingRect,
  FloatingResizeCorner,
  LayoutBounds,
  ResolvedPane,
} from "../../../plugins/pane-manager";
import {
  constrainFloatingRectToBounds,
  pointInRect,
} from "./drag";
import {
  resolveTerminalPaneHeaderGeometry,
  terminalPaneHeaderControlAt,
} from "../pane/terminal-header-geometry";
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
  hoveredPaneId: string | null;
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
  togglePaneFloating: (paneId: string) => boolean;
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

function resolveTerminalResizeHandle(
  relativeX: number,
  relativeY: number,
  rect: { width: number; height: number },
): FloatingResizeCorner | null {
  const nearLeft = relativeX <= 1;
  const nearRight = relativeX >= rect.width - 2;
  const nearTop = relativeY <= 0;
  const nearBottom = relativeY >= rect.height - 1;

  if (nearBottom && nearRight) return "bottom-right";
  if (nearBottom && nearLeft) return "bottom-left";
  if (nearTop && nearRight) return "top-right";
  if (nearTop && nearLeft) return "top-left";
  if (nearBottom) return "bottom";
  if (nearLeft) return "left";
  if (nearRight) return "right";
  // The TUI header owns the interior top row for dragging and header actions.
  return null;
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
  hoveredPaneId,
  menuState,
  openPaneMenu,
  paneMap,
  selectWindowModePane,
  setHoveredMenuItemId,
  setMenuState,
  transientFocusActive,
  togglePaneFloating,
  visibleFloatingPanes,
  width,
  windowMode,
}: UseShellTerminalPointerRuntimeOptions) {
  const {
    dragFloatingRect,
    dragRef,
    updateDividerPreview,
    updateDockPreview,
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
        const rect = getVisibleFloatingRect(visibleRect, paneId, dragFloatingRect, width, contentHeight);
        if (!pointInRect({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }, event.x, shellY)) continue;

        const relativeX = event.x - rect.x;
        const relativeY = shellY - rect.y;
        selectWindowModePane(paneId);

        const resizeHandle = resolveTerminalResizeHandle(relativeX, relativeY, rect);
        if (resizeHandle) {
          dragRef.current = {
            type: "float-resize",
            paneId,
            corner: resizeHandle,
            startX: preciseX,
            startY: preciseShellY,
            origRect: { ...rect },
          };
          updateDragFloatingRect({ paneId, rect: { ...rect } });
        }

        event.stopPropagation();
        event.preventDefault();
        return;
      }

      if (!transientFocusActive) {
        for (const divider of dockDividerLayouts) {
          if (!pointInRect(divider.rect, event.x, shellY)) continue;
          dragRef.current = {
            type: "divider",
            path: divider.path,
            axis: divider.axis,
            startX: preciseX,
            startY: preciseShellY,
            startRatio: divider.ratio,
            bounds: divider.bounds,
          };
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
        const rect = getVisibleFloatingRect(visibleRect, paneId, dragFloatingRect, width, contentHeight);
        if (!pointInRect({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }, event.x, shellY)) continue;
        const relativeX = event.x - rect.x;
        const relativeY = shellY - rect.y;
        const isFocused = focusedPaneId === paneId;
        const headerGeometry = resolveTerminalPaneHeaderGeometry(rect.width, {
          floating: true,
          focused: isFocused,
          showActions: isFocused || hoveredPaneId === paneId || menuState?.paneId === paneId,
        });
        const headerControl = relativeY === 0
          ? terminalPaneHeaderControlAt(headerGeometry, relativeX)
          : null;
        focusPane(paneId);
        if (event.button === 2 && relativeY === 0) {
          openPaneMenu(paneId, rect, event);
          return;
        }
        if (headerControl === "close") {
          handleFloatingClose(paneId);
          event.stopPropagation();
          event.preventDefault();
          return;
        }
        if (headerControl === "action") {
          openPaneMenu(paneId, rect, event);
          event.stopPropagation();
          event.preventDefault();
          return;
        }
        if (headerControl === "toggle") {
          togglePaneFloating(paneId);
          event.stopPropagation();
          event.preventDefault();
          return;
        }
        const resizeHandle = resolveTerminalResizeHandle(relativeX, relativeY, rect);
        if (resizeHandle) {
          dragRef.current = {
            type: "float-resize",
            paneId,
            corner: resizeHandle,
            startX: preciseX,
            startY: preciseShellY,
            origRect: { ...rect },
          };
          updateDragFloatingRect({ paneId, rect: { ...rect } });
          event.stopPropagation();
          event.preventDefault();
          return;
        }
        if (relativeY === 0) {
          updateDockPreview(null);
          dragRef.current = {
            type: "pane-drag",
            paneId,
            mode: "floating",
            startX: preciseX,
            startY: preciseShellY,
            origRect: { ...rect },
          };
          updateDragFloatingRect({ paneId, rect: { ...rect } });
          event.stopPropagation();
          event.preventDefault();
          return;
        }
        return;
      }

      for (const divider of dockDividerLayouts) {
        if (!pointInRect(divider.rect, event.x, shellY)) continue;
        dragRef.current = {
          type: "divider",
          path: divider.path,
          axis: divider.axis,
          startX: preciseX,
          startY: preciseShellY,
          startRatio: divider.ratio,
          bounds: divider.bounds,
        };
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
        const headerGeometry = resolveTerminalPaneHeaderGeometry(leaf.rect.width, {
          floating: false,
          focused: isFocused,
          showActions: isFocused || hoveredPaneId === leaf.instanceId || menuState?.paneId === leaf.instanceId,
        });
        const headerControl = relativeY === 0
          ? terminalPaneHeaderControlAt(headerGeometry, relativeX)
          : null;
        focusPane(leaf.instanceId);
        if (event.button === 2 && relativeY === 0) {
          openPaneMenu(leaf.instanceId, leaf.rect, event);
          return;
        }
        if (headerControl === "action") {
          openPaneMenu(leaf.instanceId, leaf.rect, event);
          event.stopPropagation();
          event.preventDefault();
          return;
        }
        if (headerControl === "toggle") {
          togglePaneFloating(leaf.instanceId);
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
          updateDockPreview(null);
          dragRef.current = {
            type: "pane-drag",
            paneId: leaf.instanceId,
            mode: "docked",
            startX: preciseX,
            startY: preciseShellY,
            origRect: { x: leaf.rect.x, y: leaf.rect.y, width: leaf.rect.width, height: leaf.rect.height },
          };
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
    dragFloatingRect,
    dragRef,
    focusPane,
    focusedPaneId,
    handleActiveDrag,
    handleFloatingClose,
    hoveredPaneId,
    menuState,
    openPaneMenu,
    paneMap,
    selectWindowModePane,
    setHoveredMenuItemId,
    setMenuState,
    transientFocusActive,
    togglePaneFloating,
    updateDividerPreview,
    updateDockPreview,
    updateDragFloatingRect,
    visibleFloatingPanes,
    windowMode,
    width,
  ]);
}
