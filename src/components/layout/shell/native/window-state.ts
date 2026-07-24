import type { DockDividerLayout, FloatingRect, LayoutBounds } from "../../../../plugins/pane-manager";
import type { NativeOccluder, NativePaneLayer } from "../../../chart/native/surface/manager";
import { DEFAULT_HEADER_HEIGHT } from "../chrome";
import type { DragPreview, HoverOverlay } from "../drag";
import { MENU_Z_INDEX } from "../menu";
import type { WindowEditDockMovePreview } from "../../window-edit/presentation";

export interface FloatingPreviewRect {
  paneId: string;
  rect: FloatingRect;
}

export interface DividerPreviewState {
  pathKey: string;
  rect: LayoutBounds;
  ratio: number;
}

export interface NativeFloatingPaneState {
  paneId: string;
  rect: FloatingRect;
  zIndex: number;
}

export interface NativeTransientOccluder {
  id: string;
  rect: LayoutBounds;
  zIndex: number;
}

export function buildNativeTransientOccluders({
  activeHoverOverlay,
  activePaneDrag,
  commandBarNativeOccluder,
  dragFloatingRect,
  dockPreview,
  menu,
  nativeWindowModePanelRect,
  windowModeDockMovePreview,
}: {
  activeHoverOverlay: HoverOverlay | null;
  activePaneDrag: { paneId: string; mode: "docked" | "floating" } | null;
  commandBarNativeOccluder: LayoutBounds | null;
  dragFloatingRect: FloatingPreviewRect | null;
  dockPreview: DragPreview | null;
  menu: { paneId: string; x: number; y: number; width: number; itemCount: number } | null;
  nativeWindowModePanelRect: LayoutBounds | null;
  windowModeDockMovePreview: WindowEditDockMovePreview | null;
}): NativeTransientOccluder[] {
  const occluders: NativeTransientOccluder[] = [];

  if (activeHoverOverlay) {
    for (const cell of activeHoverOverlay.cells) {
      occluders.push({
        id: `drag-hover:${activeHoverOverlay.targetId}:${cell.position}`,
        rect: cell.rect,
        zIndex: cell.position === "center" ? 98 : 97,
      });
    }
  }

  if (activePaneDrag
    && activePaneDrag.mode === "docked"
    && dragFloatingRect?.paneId === activePaneDrag.paneId
    && !dockPreview) {
    occluders.push({
      id: `drag-preview:${activePaneDrag.paneId}`,
      rect: dragFloatingRect.rect,
      zIndex: 95,
    });
  }

  if (dockPreview) {
    for (const preview of dockPreview.rects) {
      occluders.push({
        id: `dock-preview:${dockPreview.kind}:${preview.instanceId}`,
        rect: preview.rect,
        zIndex: 96,
      });
    }
  }

  if (windowModeDockMovePreview) {
    occluders.push({
      id: "window-mode:drop-preview",
      rect: windowModeDockMovePreview.rect,
      zIndex: 96,
    });
  }

  if (menu) {
    occluders.push({
      id: `pane-menu:${menu.paneId}`,
      rect: {
        x: menu.x,
        y: menu.y,
        width: menu.width,
        height: menu.itemCount + 2,
      },
      zIndex: MENU_Z_INDEX,
    });
  }

  if (nativeWindowModePanelRect) {
    occluders.push({
      id: "window-mode:status",
      rect: nativeWindowModePanelRect,
      zIndex: MENU_Z_INDEX - 1,
    });
  }

  if (commandBarNativeOccluder) {
    occluders.push({
      id: "command-bar:panel",
      rect: commandBarNativeOccluder,
      zIndex: Number.MAX_SAFE_INTEGER,
    });
  }

  return occluders;
}

export function buildNativeWindowState(
  dockedPaneIds: readonly string[],
  floatingPanes: readonly NativeFloatingPaneState[],
  dragFloatingRect: FloatingPreviewRect | null,
  overlay: { open: boolean; width: number; contentHeight: number },
  transientOccluders: readonly NativeTransientOccluder[] = [],
  dockDividers: readonly DockDividerLayout[] = [],
  appHeaderHeight: number = DEFAULT_HEADER_HEIGHT,
): { paneLayers: NativePaneLayer[]; occluders: NativeOccluder[] } {
  const previewedFloatingPanes = floatingPanes.map((pane) => (
    dragFloatingRect?.paneId === pane.paneId
      ? { ...pane, rect: dragFloatingRect.rect }
      : pane
  ));

  const paneLayers: NativePaneLayer[] = [
    ...dockedPaneIds.map((paneId) => ({ paneId, zIndex: 0 })),
    ...previewedFloatingPanes.map((pane) => ({ paneId: pane.paneId, zIndex: pane.zIndex })),
  ];

  const occluders: NativeOccluder[] = previewedFloatingPanes.map((pane) => ({
    id: pane.paneId,
    paneId: pane.paneId,
    rect: {
      x: pane.rect.x,
      y: pane.rect.y + appHeaderHeight,
      width: pane.rect.width,
      height: pane.rect.height,
    },
    zIndex: pane.zIndex,
  }));

  for (const divider of dockDividers) {
    occluders.push({
      id: `dock-divider:${divider.path.length > 0 ? divider.path.join(".") : "root"}`,
      paneId: null,
      rect: {
        x: divider.rect.x,
        y: divider.rect.y + appHeaderHeight,
        width: divider.rect.width,
        height: divider.rect.height,
      },
      zIndex: 1,
    });
  }

  for (const occluder of transientOccluders) {
    occluders.push({
      id: occluder.id,
      paneId: null,
      rect: {
        x: occluder.rect.x,
        y: occluder.rect.y + appHeaderHeight,
        width: occluder.rect.width,
        height: occluder.rect.height,
      },
      zIndex: occluder.zIndex,
    });
  }

  if (overlay.open) {
    occluders.push({
      id: "overlay:global",
      paneId: null,
      rect: {
        x: 0,
        y: appHeaderHeight,
        width: overlay.width,
        height: overlay.contentHeight,
      },
      zIndex: Number.MAX_SAFE_INTEGER,
    });
  }

  return { paneLayers, occluders };
}

export function resolveNativeDockDividers(
  dockDividers: readonly DockDividerLayout[],
  dividerPreview: DividerPreviewState | null,
): DockDividerLayout[] {
  if (!dividerPreview) return [...dockDividers];
  return dockDividers.map((divider) => (
    divider.path.join(".") === dividerPreview.pathKey
      ? { ...divider, rect: dividerPreview.rect, ratio: dividerPreview.ratio }
      : divider
  ));
}
