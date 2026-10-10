import { useEffect, useMemo } from "react";
import type {
  DockDividerLayout,
  DockLeafLayout,
  FloatingRect,
  LayoutBounds,
  ResolvedPane,
} from "../../../../layout/pane-manager";
import { useNativeRenderer } from "../../../../ui";
import type { DragPreview } from "../drag";
import { IDLE_DRAG, useLiveDrag, useLiveHoverOverlay, type LiveDragGeometry, type LiveDragStore } from "../drag/live";
import {
  buildNativeTransientOccluders,
  buildNativeWindowState,
  resolveNativeDockDividers,
} from "./window-state";
import type { WindowEditDockMovePreview } from "../../window-edit/presentation";

interface ShellNativeSurfaceMenuState {
  paneId: string;
  x: number;
  y: number;
  width: number;
  items: Array<unknown>;
  maxRows?: number;
}

interface ShellNativeSurfaceSyncProps {
  appHeaderHeight: number;
  commandBarNativeOccluder: LayoutBounds | null;
  contentHeight: number;
  dialogOpen: boolean;
  dockDividerLayouts: DockDividerLayout[];
  dockedPanes: ResolvedPane[];
  /** The tiled panes a moving pane can be dropped on. */
  dockLeafLayouts: DockLeafLayout[];
  /** A pane from another window over this one's edge. */
  externalDockPreview: DragPreview | null;
  live: LiveDragStore;
  menuState: ShellNativeSurfaceMenuState | null;
  nativeWindowModePanelRect: LayoutBounds | null;
  visibleFloatingPanes: Array<{ pane: ResolvedPane; rect: FloatingRect }>;
  width: number;
  windowModeDockMovePreview: WindowEditDockMovePreview | null;
}

const NO_LEAVES: DockLeafLayout[] = [];
const selectAll = (geometry: LiveDragGeometry) => geometry;
const selectIdle = () => IDLE_DRAG;

/**
 * Keeps the native image surfaces clear of the layout. A component of its own,
 * so following a drag redraws nothing but this.
 */
export function ShellNativeSurfaceSync({
  appHeaderHeight,
  commandBarNativeOccluder,
  contentHeight,
  dialogOpen,
  dockDividerLayouts,
  dockedPanes,
  dockLeafLayouts,
  externalDockPreview,
  live,
  menuState,
  nativeWindowModePanelRect,
  visibleFloatingPanes,
  width,
  windowModeDockMovePreview,
}: ShellNativeSurfaceSyncProps): null {
  // Only terminal hosts draw kitty images that need to stay clear of the layout.
  const nativeSurfaceManager = useNativeRenderer().nativeSurfaceManager;
  const {
    paneDrag: activePaneDrag,
    floating: dragFloatingRect,
    divider: dividerPreview,
    dockPreview,
  } = useLiveDrag(live, nativeSurfaceManager ? selectAll : selectIdle);
  const effectiveDockPreview = dockPreview ?? externalDockPreview;
  const activeHoverOverlay = useLiveHoverOverlay(live, nativeSurfaceManager ? dockLeafLayouts : NO_LEAVES);
  const nativeTransientOccluders = useMemo(() => buildNativeTransientOccluders({
    activeHoverOverlay,
    activePaneDrag,
    commandBarNativeOccluder,
    dragFloatingRect,
    dockPreview: effectiveDockPreview,
    menu: menuState
      ? {
          paneId: menuState.paneId,
          x: menuState.x,
          y: menuState.y,
          width: menuState.width,
          itemCount: Math.min(menuState.items.length, menuState.maxRows ?? menuState.items.length),
        }
      : null,
    nativeWindowModePanelRect,
    windowModeDockMovePreview,
  }), [
    activeHoverOverlay,
    activePaneDrag,
    commandBarNativeOccluder,
    dragFloatingRect,
    effectiveDockPreview,
    menuState,
    nativeWindowModePanelRect,
    windowModeDockMovePreview,
  ]);
  const nativeDockDividers = useMemo(
    () => resolveNativeDockDividers(dockDividerLayouts, dividerPreview),
    [dividerPreview, dockDividerLayouts],
  );
  const nativeWindowState = useMemo(
    () => buildNativeWindowState(
      dockedPanes.map((pane) => pane.instance.instanceId),
      visibleFloatingPanes.map(({ pane, rect }) => ({
        paneId: pane.instance.instanceId,
        rect,
        zIndex: pane.floating?.zIndex ?? 50,
      })),
      dragFloatingRect,
      { open: dialogOpen, width, contentHeight },
      nativeTransientOccluders,
      nativeDockDividers,
      appHeaderHeight,
    ),
    [
      appHeaderHeight,
      contentHeight,
      dialogOpen,
      dockedPanes,
      dragFloatingRect,
      nativeDockDividers,
      nativeTransientOccluders,
      visibleFloatingPanes,
      width,
    ],
  );

  useEffect(() => {
    nativeSurfaceManager?.setWindowState(nativeWindowState);
  }, [nativeSurfaceManager, nativeWindowState]);
  return null;
}
