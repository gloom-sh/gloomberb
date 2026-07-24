import { useCallback, type Dispatch, type SetStateAction } from "react";
import type {
  DockDividerLayout,
  FloatingRect,
  FloatingResizeCorner,
  LayoutBounds,
} from "../../../../plugins/pane-manager";
import type { ActionMenuState } from "../action-menu-overlay";
import type { ShellDragRuntimeState, ShellMouseEvent } from "../drag/runtime";
import type { WindowEditState } from "../../window-edit/mode";

interface UseShellNativePointerRuntimeOptions {
  appHeaderHeight: number;
  dragRuntime: ShellDragRuntimeState;
  focusPane: (paneId: string) => void;
  handleActiveDrag: (event: ShellMouseEvent) => void;
  handleFloatingClose: (paneId: string) => void;
  menuState: ActionMenuState | null;
  nativePaneChrome: boolean;
  openPaneMenu: (
    paneId: string,
    rect: LayoutBounds,
    event?: { preventDefault?: () => void; stopPropagation?: () => void },
  ) => void;
  selectWindowModePane: (paneId: string) => void;
  setHoveredMenuItemId: Dispatch<SetStateAction<string | null>>;
  setMenuState: Dispatch<SetStateAction<ActionMenuState | null>>;
  transientFocusActive: boolean;
  togglePaneFloating: (paneId: string) => boolean;
  windowMode: WindowEditState | null;
}

export function useShellNativePointerRuntime({
  appHeaderHeight,
  dragRuntime,
  focusPane,
  handleActiveDrag,
  handleFloatingClose,
  menuState,
  nativePaneChrome,
  openPaneMenu,
  selectWindowModePane,
  setHoveredMenuItemId,
  setMenuState,
  transientFocusActive,
  togglePaneFloating,
  windowMode,
}: UseShellNativePointerRuntimeOptions) {
  const {
    dragRef,
    updateDividerPreview,
    updateDockPreview,
    updateDragFloatingRect,
  } = dragRuntime;

  const getShellPointer = useCallback((event: ShellMouseEvent) => ({
    x: event.preciseX ?? event.x,
    y: (event.preciseY ?? event.y) - appHeaderHeight,
  }), [appHeaderHeight]);

  const focusNativePane = useCallback((paneId: string) => {
    if (menuState) {
      setMenuState(null);
      setHoveredMenuItemId(null);
    }
    focusPane(paneId);
  }, [focusPane, menuState, setHoveredMenuItemId, setMenuState]);

  const handleNativePaneMouseDown = useCallback((paneId: string, event: ShellMouseEvent) => {
    if (windowMode) {
      selectWindowModePane(paneId);
      event.stopPropagation();
      event.preventDefault();
      return;
    }
    focusNativePane(paneId);
  }, [focusNativePane, selectWindowModePane, windowMode]);

  const startNativeFloatingDrag = useCallback((paneId: string, rect: FloatingRect, event: ShellMouseEvent) => {
    if (!nativePaneChrome) return;
    if (windowMode) return;
    if (transientFocusActive) return;
    if (event.button === 2) return;

    const pointer = getShellPointer(event);
    focusNativePane(paneId);
    updateDockPreview(null);
    dragRef.current = {
      type: "pane-drag",
      paneId,
      mode: "floating",
      startX: pointer.x,
      startY: pointer.y,
      origRect: { ...rect },
    };
    updateDragFloatingRect({ paneId, rect: { ...rect } });
    event.preventDefault();
  }, [dragRef, focusNativePane, getShellPointer, nativePaneChrome, transientFocusActive, updateDockPreview, updateDragFloatingRect, windowMode]);

  const startNativeDockedDrag = useCallback((paneId: string, rect: LayoutBounds, event: ShellMouseEvent) => {
    if (!nativePaneChrome) return;
    if (windowMode) return;
    if (transientFocusActive) return;
    if (event.button === 2) return;

    const pointer = getShellPointer(event);
    focusNativePane(paneId);
    updateDockPreview(null);
    dragRef.current = {
      type: "pane-drag",
      paneId,
      mode: "docked",
      startX: pointer.x,
      startY: pointer.y,
      origRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
    event.preventDefault();
  }, [dragRef, focusNativePane, getShellPointer, nativePaneChrome, transientFocusActive, updateDockPreview, windowMode]);

  const startNativeFloatResize = useCallback((
    paneId: string,
    rect: FloatingRect,
    corner: FloatingResizeCorner,
    event: ShellMouseEvent,
  ) => {
    if (!nativePaneChrome) return;
    if (transientFocusActive) return;

    const pointer = getShellPointer(event);
    if (windowMode) {
      selectWindowModePane(paneId);
    } else {
      focusNativePane(paneId);
    }
    dragRef.current = {
      type: "float-resize",
      paneId,
      corner,
      startX: pointer.x,
      startY: pointer.y,
      origRect: { ...rect },
    };
    updateDragFloatingRect({ paneId, rect: { ...rect } });
    event.stopPropagation();
    event.preventDefault();
  }, [dragRef, focusNativePane, getShellPointer, nativePaneChrome, selectWindowModePane, transientFocusActive, updateDragFloatingRect, windowMode]);

  const startNativeDividerDrag = useCallback((divider: DockDividerLayout, event: ShellMouseEvent) => {
    if (!nativePaneChrome) return;
    if (transientFocusActive) return;

    const pointer = getShellPointer(event);
    if (menuState) {
      setMenuState(null);
      setHoveredMenuItemId(null);
    }
    dragRef.current = {
      type: "divider",
      path: divider.path,
      axis: divider.axis,
      startX: pointer.x,
      startY: pointer.y,
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
  }, [dragRef, getShellPointer, menuState, nativePaneChrome, setHoveredMenuItemId, setMenuState, transientFocusActive, updateDividerPreview]);

  const handlePaneAction = useCallback((paneId: string, rect: LayoutBounds, event: ShellMouseEvent) => {
    if (windowMode) return;
    if (event.button === 2) return;
    event.stopPropagation();
    event.preventDefault();
    openPaneMenu(paneId, rect, event);
  }, [openPaneMenu, windowMode]);

  const handleNativePaneContextMenu = useCallback((paneId: string, rect: LayoutBounds, event: ShellMouseEvent) => {
    if (windowMode) return;
    openPaneMenu(paneId, rect, event);
  }, [openPaneMenu, windowMode]);

  const handleFloatingCloseMouseDown = useCallback((paneId: string, event: ShellMouseEvent) => {
    if (windowMode) return;
    event.stopPropagation();
    event.preventDefault();
    handleFloatingClose(paneId);
  }, [handleFloatingClose, windowMode]);

  const handlePaneFloatToggle = useCallback((paneId: string, event: ShellMouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    if (windowMode || event.button === 2) return;
    togglePaneFloating(paneId);
  }, [togglePaneFloating, windowMode]);

  return {
    handleFloatingCloseMouseDown,
    handleNativeDrag: handleActiveDrag,
    handleNativePaneContextMenu,
    handleNativePaneMouseDown,
    handlePaneAction,
    handlePaneFloatToggle,
    startNativeDividerDrag,
    startNativeDockedDrag,
    startNativeFloatingDrag,
    startNativeFloatResize,
  };
}
