import {
  useCallback,
  useEffect,
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
  sameRect,
  type DragPreview,
  type PaneDragRectState,
  type ResizeEdges,
} from "./index";
import type { ActionMenuState } from "../action-menu-overlay";
import type { DividerPreviewState } from "../native/window-state";
import { createLiveDragStore, IDLE_DRAG, type LiveDockGeometry, type LiveDragStore } from "./live";
import { beginLiveResize, createCatchUp } from "../../../../ui/live-resize";
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
    /** Omitted: the bottom-right corner. */
    edges?: ResizeEdges;
  };

export interface ShellMouseEvent {
  type: string;
  x: number;
  y: number;
  button?: number;
  preciseX?: number;
  preciseY?: number;
  /** Desktop: where the browser predicts the pointer a moment later, for drawing only. */
  predictedX?: number;
  predictedY?: number;
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
  /** The release: the drag is over and what it previewed is laid out. */
  endDrag: () => void;
  hasActiveDrag: () => boolean;
  /** Positions that follow the pointer, outside React state. */
  live: LiveDragStore;
  /** The tiled pane whose drop grid is under the pointer. */
  setHoverTarget: (targetId: string | null) => void;
  startDrag: (drag: DragMode) => void;
  /** `dock`: on the desktop, the panes and dividers under the split, where the pointer has them. */
  updateDividerPreview: (next: DividerPreviewState | null, dock?: LiveDockGeometry | null) => void;
  updateDockPreview: (next: DragPreview | null) => void;
  updateDragFloatingRect: (next: { paneId: string; rect: FloatingRect } | null) => void;
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
  nativePaneChrome,
  width,
}: {
  contentHeight: number;
  nativePaneChrome: boolean;
  width: number;
}): ShellDragRuntimeState {
  const dragRef = useRef<DragMode | null>(null);
  const [live] = useState(createLiveDragStore);
  // A desktop resize: the content of what it resizes catches up a few times a
  // second, and size-driven renders elsewhere wait for its end.
  const [catchUp] = useState(() => createCatchUp(() => live.catchUp()));
  const endLiveResizeRef = useRef<(() => void) | null>(null);
  const finishLiveResize = useCallback(() => {
    catchUp.cancel();
    const end = endLiveResizeRef.current;
    endLiveResizeRef.current = null;
    end?.();
  }, [catchUp]);
  useEffect(() => finishLiveResize, [finishLiveResize]);

  const updateDragFloatingRect = useCallback((next: { paneId: string; rect: FloatingRect } | null) => {
    const current = live.get();
    const floating = next
      ? { paneId: next.paneId, rect: constrainFloatingRectToBounds(next.rect, width, contentHeight) }
      : null;
    // A desktop pane being moved or resized follows by restyling itself
    // (`move`); its start and end, and every terminal frame, redraw through React.
    const follows = nativePaneChrome
      && floating !== null
      && current.floating?.paneId === floating.paneId
      && (current.paneDrag?.paneId === floating.paneId || current.paneResize?.paneId === floating.paneId);
    if (follows) {
      live.move({ floating });
      if (current.paneResize?.paneId === floating.paneId) catchUp.request();
    } else {
      live.set({ floating });
    }
  }, [catchUp, contentHeight, live, nativePaneChrome, width]);

  const setHoverTarget = useCallback((targetId: string | null) => {
    live.set({ hoverTargetId: targetId });
  }, [live]);

  const updateDividerPreview = useCallback((next: DividerPreviewState | null, dock: LiveDockGeometry | null = null) => {
    const current = live.get().divider;
    // The desktop divider and the panes on both sides follow by restyling
    // themselves; React hears only that it started or ended, and the panes'
    // content catches up a few times a second.
    if (nativePaneChrome && next && current?.pathKey === next.pathKey) {
      live.move({ divider: next, dock });
      if (dock) catchUp.request();
    } else {
      live.set({ divider: next, dock: next ? dock : null });
    }
  }, [catchUp, live, nativePaneChrome]);

  const updateDockPreview = useCallback((next: DragPreview | null) => {
    // Recomputed on every move; only a different target is news.
    if (sameDragPreview(live.get().dockPreview, next)) return;
    live.set({ dockPreview: next });
  }, [live]);

  const startDrag = useCallback((drag: DragMode) => {
    finishLiveResize();
    dragRef.current = drag;
    if (nativePaneChrome && drag.type !== "pane-drag") endLiveResizeRef.current = beginLiveResize();
    live.set({
      paneDrag: drag.type === "pane-drag" ? { paneId: drag.paneId, mode: drag.mode } : null,
      paneResize: drag.type === "float-resize" ? { paneId: drag.paneId } : null,
    });
  }, [finishLiveResize, live, nativePaneChrome]);

  const endDrag = useCallback(() => {
    dragRef.current = null;
    live.set({ paneDrag: null, paneResize: null });
    finishLiveResize();
  }, [finishLiveResize, live]);

  const cancelActiveDrag = useCallback(() => {
    dragRef.current = null;
    live.set(IDLE_DRAG);
    finishLiveResize();
  }, [finishLiveResize, live]);

  const hasActiveDrag = useCallback(() => dragRef.current != null, []);

  return {
    cancelActiveDrag,
    dragRef,
    endDrag,
    hasActiveDrag,
    live,
    setHoverTarget,
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
  openPaneDocs: (paneId: string) => void;
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
  openPaneDocs,
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
    openPaneDocs,
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
