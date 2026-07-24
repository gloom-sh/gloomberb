import { useEffect, useMemo } from "react";
import type {
  DockDividerLayout,
  FloatingRect,
  LayoutBounds,
  ResolvedPane,
} from "../../../../plugins/pane-manager";
import { useNativeRenderer } from "../../../../ui";
import { getNativeSurfaceManager } from "../../../chart/native/surface/manager";
import type { DragPreview } from "../drag";
import {
  buildNativeTransientOccluders,
  buildNativeWindowState,
  resolveNativeDockDividers,
  type DividerPreviewState,
} from "./window-state";
import type { WindowEditDockMovePreview } from "../../window-edit/presentation";

interface ShellNativeSurfaceMenuState {
  paneId: string;
  x: number;
  y: number;
  width: number;
  items: Array<unknown>;
}

interface UseShellNativeSurfaceWindowStateOptions {
  activeHoverOverlay: Parameters<typeof buildNativeTransientOccluders>[0]["activeHoverOverlay"];
  activePaneDrag: { paneId: string; mode: "docked" | "floating" } | null;
  appHeaderHeight: number;
  commandBarNativeOccluder: LayoutBounds | null;
  contentHeight: number;
  dialogOpen: boolean;
  dividerPreview: DividerPreviewState | null;
  dockDividerLayouts: DockDividerLayout[];
  dockedPanes: ResolvedPane[];
  dragFloatingRect: { paneId: string; rect: FloatingRect } | null;
  effectiveDockPreview: DragPreview | null;
  menuState: ShellNativeSurfaceMenuState | null;
  nativeWindowModePanelRect: LayoutBounds | null;
  visibleFloatingPanes: Array<{ pane: ResolvedPane; rect: FloatingRect }>;
  width: number;
  windowModeDockMovePreview: WindowEditDockMovePreview | null;
}

export function useShellNativeSurfaceWindowState({
  activeHoverOverlay,
  activePaneDrag,
  appHeaderHeight,
  commandBarNativeOccluder,
  contentHeight,
  dialogOpen,
  dividerPreview,
  dockDividerLayouts,
  dockedPanes,
  dragFloatingRect,
  effectiveDockPreview,
  menuState,
  nativeWindowModePanelRect,
  visibleFloatingPanes,
  width,
  windowModeDockMovePreview,
}: UseShellNativeSurfaceWindowStateOptions) {
  const renderer = useNativeRenderer();
  const nativeSurfaceManager = useMemo(() => getNativeSurfaceManager(renderer), [renderer]);
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
          itemCount: menuState.items.length,
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
    nativeSurfaceManager.setWindowState(nativeWindowState);
  }, [nativeSurfaceManager, nativeWindowState]);
}
