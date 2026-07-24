import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { useRafCallback } from "../../../../react/use-raf-callback";
import {
  type DockDividerLayout,
  type DockGeometryOptions,
  type DockLeafLayout,
  type FloatingRect,
  type FloatingResizeCorner,
  type LayoutBounds,
  type ResolvedPane,
} from "../../../../plugins/pane-manager";
import type { AppAction } from "../../../../state/app/context";
import type { LayoutConfig } from "../../../../types/config";
import {
  constrainFloatingRectToBounds,
  makeSnapGuides,
  type DragPreview,
  type PaneDragRectState,
} from "./index";
import type { ActionMenuState } from "../action-menu-overlay";
import type { DividerPreviewState } from "../native/window-state";
import type { WindowEditState } from "../../window-edit/mode";
import { useShellActiveDrag } from "../active-drag";
import { useShellNativePointerRuntime } from "../native/pointer-runtime";
import { useShellTerminalPointerRuntime } from "../terminal-pointer-runtime";

type DragMode =
  | {
    type: "divider";
    path: Array<0 | 1>;
    axis: "horizontal" | "vertical";
    startX: number;
    startY: number;
    startRatio: number;
    bounds: LayoutBounds;
  }
  | {
    type: "pane-drag";
    paneId: string;
  } & PaneDragRectState
  | {
    type: "float-resize";
    paneId: string;
    corner: FloatingResizeCorner;
    startX: number;
    startY: number;
    origRect: FloatingRect;
  };

export interface ShellMouseEvent {
  type: string;
  x: number;
  y: number;
  button?: number;
  preciseX?: number;
  preciseY?: number;
  stopPropagation: () => void;
  preventDefault: () => void;
}

export interface VisibleFloatingPane {
  pane: ResolvedPane;
  rect: FloatingRect;
}

export interface ShellDragRuntimeState {
  cancelActiveDrag: () => void;
  dividerPreview: DividerPreviewState | null;
  dividerPreviewRef: MutableRefObject<DividerPreviewState | null>;
  dockPreview: DragPreview | null;
  dockPreviewRef: MutableRefObject<DragPreview | null>;
  dragCursor: { x: number; y: number } | null;
  dragFloatingRect: { paneId: string; rect: FloatingRect } | null;
  dragRef: MutableRefObject<DragMode | null>;
  hasActiveDrag: () => boolean;
  setDragCursor: Dispatch<SetStateAction<{ x: number; y: number } | null>>;
  updateDividerPreview: (next: DividerPreviewState | null) => void;
  updateDockPreview: (next: DragPreview | null) => void;
  updateDragFloatingRect: (next: { paneId: string; rect: FloatingRect } | null) => void;
}

export function useShellDragRuntimeState({
  contentHeight,
  throttleFloatingPreview = false,
  width,
}: {
  contentHeight: number;
  throttleFloatingPreview?: boolean;
  width: number;
}): ShellDragRuntimeState {
  const dragRef = useRef<DragMode | null>(null);
  const [dragFloatingRect, setDragFloatingRect] = useState<{ paneId: string; rect: FloatingRect } | null>(null);
  const pendingDragFloatingRectRef = useRef<{ paneId: string; rect: FloatingRect } | null>(null);
  const [dragCursor, setDragCursor] = useState<{ x: number; y: number } | null>(null);
  const [dividerPreview, setDividerPreview] = useState<DividerPreviewState | null>(null);
  const [dockPreview, setDockPreview] = useState<DragPreview | null>(null);
  const dividerPreviewRef = useRef<DividerPreviewState | null>(null);
  const dockPreviewRef = useRef<DragPreview | null>(null);
  const flushDragFloatingRect = useRafCallback(() => {
    setDragFloatingRect(pendingDragFloatingRectRef.current);
  });

  const updateDragFloatingRect = useCallback((next: { paneId: string; rect: FloatingRect } | null) => {
    const constrainedNext = next
      ? { paneId: next.paneId, rect: constrainFloatingRectToBounds(next.rect, width, contentHeight) }
      : null;
    pendingDragFloatingRectRef.current = constrainedNext;
    if (!next) {
      setDragFloatingRect(null);
      return;
    }
    if (!throttleFloatingPreview) {
      setDragFloatingRect(constrainedNext);
      return;
    }
    flushDragFloatingRect();
  }, [contentHeight, flushDragFloatingRect, throttleFloatingPreview, width]);

  const updateDividerPreview = useCallback((next: DividerPreviewState | null) => {
    dividerPreviewRef.current = next;
    setDividerPreview(next);
  }, []);

  const updateDockPreview = useCallback((next: DragPreview | null) => {
    dockPreviewRef.current = next;
    setDockPreview(next);
  }, []);

  const cancelActiveDrag = useCallback(() => {
    dragRef.current = null;
    updateDragFloatingRect(null);
    setDragCursor(null);
    updateDividerPreview(null);
    updateDockPreview(null);
  }, [updateDividerPreview, updateDockPreview, updateDragFloatingRect]);

  const hasActiveDrag = useCallback(() => dragRef.current != null, []);

  return {
    cancelActiveDrag,
    dividerPreview,
    dividerPreviewRef,
    dockPreview,
    dockPreviewRef,
    dragCursor,
    dragFloatingRect,
    dragRef,
    hasActiveDrag,
    setDragCursor,
    updateDividerPreview,
    updateDockPreview,
    updateDragFloatingRect,
  };
}

interface UseShellPointerRuntimeOptions {
  appHeaderHeight: number;
  bounds: LayoutBounds;
  closePaneMenu: () => void;
  contentHeight: number;
  dispatch: Dispatch<AppAction>;
  dockGeometryOptions: DockGeometryOptions;
  dockDividerLayouts: DockDividerLayout[];
  dockLeafLayouts: DockLeafLayout[];
  dragRuntime: ShellDragRuntimeState;
  focusPane: (paneId: string) => void;
  focusedPaneId: string | null;
  handleFloatingClose: (paneId: string) => void;
  hoveredPaneId: string | null;
  menuState: ActionMenuState | null;
  nativePaneChrome: boolean;
  openPaneMenu: (
    paneId: string,
    rect: LayoutBounds,
    event?: { preventDefault?: () => void; stopPropagation?: () => void },
  ) => void;
  paneMap: Map<string, ResolvedPane>;
  persistLayout: (nextLayout: LayoutConfig, options?: { pushHistory?: boolean }) => void;
  precisePointer: boolean | undefined;
  selectWindowModePane: (paneId: string) => void;
  setHoveredMenuItemId: Dispatch<SetStateAction<string | null>>;
  setMenuState: Dispatch<SetStateAction<ActionMenuState | null>>;
  snapGuides: ReturnType<typeof makeSnapGuides>;
  transientFocusActive: boolean;
  togglePaneFloating: (paneId: string) => boolean;
  updateWindowModePreviewLayout: (nextLayout: LayoutConfig, paneId?: string) => void;
  visibleFloatingPanes: VisibleFloatingPane[];
  visibleLayout: LayoutConfig;
  width: number;
  windowMode: WindowEditState | null;
}

export function useShellPointerRuntime({
  appHeaderHeight,
  bounds,
  closePaneMenu,
  contentHeight,
  dispatch,
  dockGeometryOptions,
  dockDividerLayouts,
  dockLeafLayouts,
  dragRuntime,
  focusPane,
  focusedPaneId,
  handleFloatingClose,
  hoveredPaneId,
  menuState,
  nativePaneChrome,
  openPaneMenu,
  paneMap,
  persistLayout,
  precisePointer,
  selectWindowModePane,
  setHoveredMenuItemId,
  setMenuState,
  snapGuides,
  transientFocusActive,
  togglePaneFloating,
  updateWindowModePreviewLayout,
  visibleFloatingPanes,
  visibleLayout,
  width,
  windowMode,
}: UseShellPointerRuntimeOptions) {
  const handleActiveDrag = useShellActiveDrag({
    appHeaderHeight,
    bounds,
    contentHeight,
    dispatch,
    dockGeometryOptions,
    dockLeafLayouts,
    focusPane,
    dragRuntime,
    nativePaneChrome,
    paneMap,
    persistLayout,
    precisePointer,
    snapGuides,
    updateWindowModePreviewLayout,
    visibleLayout,
    windowMode,
    width,
  });

  const handleMouse = useShellTerminalPointerRuntime({
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
  });

  const nativePointerRuntime = useShellNativePointerRuntime({
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
  });

  return {
    handleMouse,
    ...nativePointerRuntime,
  };
}
