import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import {
  type DockDividerLayout,
  type DockGeometryOptions,
  type DockLeafLayout,
  type FloatingRect,
  type LayoutBounds,
  type ResolvedPane,
} from "../../../../layout/pane-manager";
import type { LayoutConfig } from "../../../../types/config";
import {
  constrainFloatingRectToBounds,
  makeSnapGuides,
  type DragPreview,
  type PaneDragRectState,
} from "./index";
import type { ActionMenuState } from "../action-menu-overlay";
import type { DividerPreviewState } from "../native/window-state";
import { createLiveDragStore, IDLE_DRAG, type LiveDragStore } from "./live";
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
  /** Whether a later handler has claimed this pointer interaction. */
  isDefaultPrevented?: () => boolean;
  stopPropagation: () => void;
  preventDefault: () => void;
}

export interface VisibleFloatingPane {
  pane: ResolvedPane;
  rect: FloatingRect;
}

export interface ShellDragRuntimeState {
  cancelActiveDrag: () => void;
  dragRef: MutableRefObject<DragMode | null>;
  hasActiveDrag: () => boolean;
  /** Positions that follow the pointer, outside React state. */
  live: LiveDragStore;
  setDragCursor: (next: { x: number; y: number } | null) => void;
  startDrag: (drag: DragMode) => void;
  updateDividerPreview: (next: DividerPreviewState | null) => void;
  updateDockPreview: (next: DragPreview | null) => void;
  updateDragFloatingRect: (next: { paneId: string; rect: FloatingRect } | null) => void;
}

function sameRect(a: LayoutBounds, b: LayoutBounds): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function sameDragPreview(a: DragPreview | null, b: DragPreview | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind || !sameRect(a.rect, b.rect)) return false;
  if (a.kind === "snap" && b.kind === "snap") return a.position === b.position;
  if (a.kind === "dock" && b.kind === "dock") {
    const [x, y] = [a.target, b.target];
    if (x.kind === "frame" && y.kind === "frame") return x.edge === y.edge;
    if (x.kind === "leaf" && y.kind === "leaf") return x.targetId === y.targetId && x.position === y.position;
  }
  return false;
}

export function useShellDragRuntimeState({
  contentHeight,
  width,
}: {
  contentHeight: number;
  width: number;
}): ShellDragRuntimeState {
  const dragRef = useRef<DragMode | null>(null);
  const [live] = useState(createLiveDragStore);

  const updateDragFloatingRect = useCallback((next: { paneId: string; rect: FloatingRect } | null) => {
    live.set({
      floating: next
        ? { paneId: next.paneId, rect: constrainFloatingRectToBounds(next.rect, width, contentHeight) }
        : null,
    });
  }, [contentHeight, live, width]);

  const setDragCursor = useCallback((next: { x: number; y: number } | null) => {
    live.set({ cursor: next });
  }, [live]);

  const updateDividerPreview = useCallback((next: DividerPreviewState | null) => {
    live.set({ divider: next });
  }, [live]);

  const updateDockPreview = useCallback((next: DragPreview | null) => {
    // Recomputed on every move; only a different target is news.
    if (sameDragPreview(live.get().dockPreview, next)) return;
    live.set({ dockPreview: next });
  }, [live]);

  const startDrag = useCallback((drag: DragMode) => {
    dragRef.current = drag;
    live.set({ paneDrag: drag.type === "pane-drag" ? { paneId: drag.paneId, mode: drag.mode } : null });
  }, [live]);

  const cancelActiveDrag = useCallback(() => {
    dragRef.current = null;
    live.set(IDLE_DRAG);
  }, [live]);

  const hasActiveDrag = useCallback(() => dragRef.current != null, []);

  return {
    cancelActiveDrag,
    dragRef,
    hasActiveDrag,
    live,
    setDragCursor,
    startDrag,
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
  dockGeometryOptions: DockGeometryOptions;
  dockDividerLayouts: DockDividerLayout[];
  dockLeafLayouts: DockLeafLayout[];
  dragRuntime: ShellDragRuntimeState;
  focusPane: (paneId: string) => void;
  focusedPaneId: string | null;
  handleFloatingClose: (paneId: string) => void;
  restoreFullscreen: () => void;
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
  updateWindowModePreviewLayout: (nextLayout: LayoutConfig, paneId?: string) => void;
  visibleFloatingPanes: VisibleFloatingPane[];
  visibleLayout: LayoutConfig;
  width: number;
  windowMode: WindowEditState | null;
  commandBarOpen: boolean;
}

export function useShellPointerRuntime({
  appHeaderHeight,
  bounds,
  closePaneMenu,
  contentHeight,
  dockGeometryOptions,
  dockDividerLayouts,
  dockLeafLayouts,
  dragRuntime,
  focusPane,
  focusedPaneId,
  handleFloatingClose,
  restoreFullscreen,
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
  updateWindowModePreviewLayout,
  visibleFloatingPanes,
  visibleLayout,
  width,
  windowMode,
  commandBarOpen,
}: UseShellPointerRuntimeOptions) {
  const handleActiveDrag = useShellActiveDrag({
    appHeaderHeight,
    bounds,
    contentHeight,
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
    windowMode,
    commandBarOpen,
  });

  return {
    handleMouse,
    ...nativePointerRuntime,
  };
}
