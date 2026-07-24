import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useShortcut } from "../../../../react/input";
import {
  dockFloatingPaneAtCurrentRect,
  floatAtRect,
  getDockLeafLayouts,
  isPaneInLayout,
  type DockGeometryOptions,
  type LayoutBounds,
} from "../../../../plugins/pane-manager";
import type { PluginRegistry, WindowEditMode } from "../../../../plugins/registry";
import type { LayoutConfig } from "../../../../types/config";
import {
  applyWindowEditDirection,
  cycleWindowEditFocus,
  cycleWindowEditPane,
  cycleWindowEditTarget,
  directionFromWindowEditKey,
  getWindowEditPaneIds,
  normalizeWindowEditFocus,
  raiseWindowEditPane,
  resolveWindowEditCommitLayout,
  setWindowEditMode,
  setWindowEditPane,
  windowEditHasPendingCommit,
  type WindowEditState,
} from "../../window-edit/mode";
import { resolveWindowEditDockMovePreview } from "../../window-edit/presentation";
import { resolveNativeWindowEditPanelRect } from "../../window-edit/status";

interface UseShellWindowModeOptions {
  bounds: LayoutBounds;
  cancelActiveDrag: () => void;
  closePaneMenu: () => void;
  contentHeight: number;
  dockGeometryOptions: DockGeometryOptions;
  focusPane: (paneId: string) => void;
  focusedPaneId: string | null;
  hasActiveDrag: () => boolean;
  nativePaneChrome: boolean;
  overlayOpen: boolean;
  persistLayout: (nextLayout: LayoutConfig, options?: { pushHistory?: boolean }) => void;
  pluginRegistry: PluginRegistry;
  visibleLayout: LayoutConfig;
  width: number;
}

export function useShellWindowMode({
  bounds,
  cancelActiveDrag,
  closePaneMenu,
  contentHeight,
  dockGeometryOptions,
  focusPane,
  focusedPaneId,
  hasActiveDrag,
  nativePaneChrome,
  overlayOpen,
  persistLayout,
  pluginRegistry,
  visibleLayout,
  width,
}: UseShellWindowModeOptions): {
  activeLayout: LayoutConfig;
  nativeWindowModePanelRect: LayoutBounds | null;
  selectWindowModePane: (paneId: string) => void;
  startWindowMode: (paneId?: string, mode?: WindowEditMode) => void;
  updateWindowModePreviewLayout: (nextLayout: LayoutConfig, paneId?: string) => void;
  windowMode: WindowEditState | null;
  windowModeDockMovePreview: ReturnType<typeof resolveWindowEditDockMovePreview>;
} {
  const [windowMode, setWindowMode] = useState<WindowEditState | null>(null);
  const nativeWindowModePanelRect = useMemo(
    () => (nativePaneChrome && windowMode ? resolveNativeWindowEditPanelRect(width, contentHeight) : null),
    [contentHeight, nativePaneChrome, width, windowMode],
  );
  const windowModePaneId = windowMode?.paneId;
  const activeLayout = windowMode?.previewLayout ?? visibleLayout;
  const windowModePaneIds = useMemo(
    () => getWindowEditPaneIds(activeLayout, bounds, dockGeometryOptions),
    [activeLayout, bounds, dockGeometryOptions],
  );
  const windowModeDockMovePreview = useMemo(
    () => resolveWindowEditDockMovePreview(windowMode, bounds, dockGeometryOptions),
    [bounds, dockGeometryOptions, windowMode],
  );

  const startWindowMode = useCallback((paneId?: string, mode: WindowEditMode = "move") => {
    if (hasActiveDrag()) cancelActiveDrag();
    const targetPaneId = paneId ?? focusedPaneId;
    if (!targetPaneId || !isPaneInLayout(visibleLayout, targetPaneId)) {
      pluginRegistry.notify({ body: "Focus a window to move or resize it", type: "info" });
      return;
    }
    closePaneMenu();
    const previewLayout = raiseWindowEditPane(visibleLayout, targetPaneId);
    focusPane(targetPaneId);
    setWindowMode({
      paneId: targetPaneId,
      previewLayout,
      mode,
      focus: normalizeWindowEditFocus({ kind: "move" }, previewLayout, targetPaneId, mode, bounds, dockGeometryOptions),
      dirty: previewLayout !== visibleLayout,
    });
  }, [
    bounds,
    cancelActiveDrag,
    closePaneMenu,
    dockGeometryOptions,
    focusPane,
    focusedPaneId,
    hasActiveDrag,
    pluginRegistry,
    visibleLayout,
  ]);

  useEffect(() => {
    if (windowModePaneId) focusPane(windowModePaneId);
  }, [focusPane, windowModePaneId]);

  useEffect(() => {
    pluginRegistry.openWindowModeFn = startWindowMode;
    return () => {
      if (pluginRegistry.openWindowModeFn === startWindowMode) {
        pluginRegistry.openWindowModeFn = () => {};
      }
    };
  }, [pluginRegistry, startWindowMode]);

  const cancelWindowMode = useCallback(() => {
    setWindowMode(null);
  }, []);

  useLayoutEffect(() => {
    if (overlayOpen && windowMode) cancelWindowMode();
  }, [cancelWindowMode, overlayOpen, windowMode]);

  const commitWindowMode = useCallback(() => {
    if (!windowMode) return;
    const committedLayout = resolveWindowEditCommitLayout(windowMode, bounds, dockGeometryOptions);
    const hasPendingCommit = windowEditHasPendingCommit(windowMode, bounds, dockGeometryOptions);
    if (!hasPendingCommit) {
      focusPane(windowMode.paneId);
      setWindowMode(null);
      return;
    }

    persistLayout(committedLayout);
    focusPane(windowMode.paneId);
    setWindowMode({
      paneId: windowMode.paneId,
      previewLayout: committedLayout,
      mode: "move",
      focus: normalizeWindowEditFocus({ kind: "move" }, committedLayout, windowMode.paneId, "move", bounds, dockGeometryOptions),
      dirty: false,
      notice: "Committed",
    });
  }, [bounds, dockGeometryOptions, focusPane, persistLayout, windowMode]);

  const updateWindowModePreviewLayout = useCallback((nextLayout: LayoutConfig, paneId?: string) => {
    setWindowMode((current) => {
      if (!current) return current;
      const nextPaneId = paneId ?? current.paneId;
      return {
        ...current,
        paneId: nextPaneId,
        previewLayout: nextLayout,
        focus: normalizeWindowEditFocus(current.focus, nextLayout, nextPaneId, current.mode, bounds, dockGeometryOptions),
        dirty: true,
        notice: undefined,
      };
    });
  }, [bounds, dockGeometryOptions]);

  const selectWindowModePane = useCallback((paneId: string) => {
    setWindowMode((current) => {
      if (!current || current.paneId === paneId) return current;
      return setWindowEditPane(current, paneId, bounds, dockGeometryOptions);
    });
  }, [bounds, dockGeometryOptions]);

  useShortcut((event) => {
    if (!windowMode) return;
    if (event.ctrl || event.meta || event.super || event.alt) return;
    const name = (event.name ?? event.key ?? "").toLowerCase();
    let handled = true;

    if (name === "escape" || name === "esc") {
      cancelWindowMode();
    } else if (name === "enter" || name === "return") {
      commitWindowMode();
    } else if (name === "m") {
      setWindowMode((current) => current
        ? setWindowEditMode(current, "move", bounds, dockGeometryOptions)
        : current);
    } else if (name === "r") {
      setWindowMode((current) => current
        ? setWindowEditMode(current, "resize", bounds, dockGeometryOptions)
        : current);
    } else if (name === "d") {
      if (windowMode.mode !== "move") {
        handled = false;
      } else {
        setWindowMode((current) => {
          if (!current || current.mode !== "move") return current;
          const paneInstance = current.previewLayout.instances.find((entry) => entry.instanceId === current.paneId);
          const paneDef = paneInstance ? pluginRegistry.panes.get(paneInstance.paneId) : undefined;
          if (!paneDef) return current;
          const isFloating = current.previewLayout.floating.some((entry) => entry.instanceId === current.paneId);
          const tiledRect = isFloating
            ? null
            : getDockLeafLayouts(current.previewLayout, bounds, dockGeometryOptions)
              .find((leaf) => leaf.instanceId === current.paneId)?.rect;
          const nextLayout = isFloating
            ? dockFloatingPaneAtCurrentRect(current.previewLayout, current.paneId, bounds)
            : tiledRect
              ? floatAtRect(current.previewLayout, current.paneId, tiledRect)
              : current.previewLayout;
          return {
            ...current,
            previewLayout: nextLayout,
            focus: normalizeWindowEditFocus({ kind: "move" }, nextLayout, current.paneId, "move", bounds, dockGeometryOptions),
            dirty: current.dirty || nextLayout !== current.previewLayout,
            notice: undefined,
          };
        });
      }
    } else if (name === "w") {
      setWindowMode((current) => current
        ? current.mode === "move" && current.focus.kind === "dock-move"
          ? cycleWindowEditTarget(current, bounds, dockGeometryOptions, event.shift ? -1 : 1)
          : cycleWindowEditPane(current, windowModePaneIds, bounds, dockGeometryOptions, event.shift ? -1 : 1)
        : current);
    } else if (name === "tab") {
      setWindowMode((current) => current
        ? current.mode === "move"
          ? current.focus.kind === "dock-move"
            ? cycleWindowEditTarget(current, bounds, dockGeometryOptions, event.shift ? -1 : 1)
            : cycleWindowEditPane(current, windowModePaneIds, bounds, dockGeometryOptions, event.shift ? -1 : 1)
          : {
              ...current,
              focus: cycleWindowEditFocus(
                current.focus,
                current.previewLayout,
                current.paneId,
                current.mode,
                bounds,
                dockGeometryOptions,
                event.shift ? -1 : 1,
              ),
            }
        : current);
    } else {
      const direction = directionFromWindowEditKey(event);
      if (direction) {
        setWindowMode((current) => current
          ? applyWindowEditDirection(current, direction, event.shift, bounds, dockGeometryOptions)
          : current);
      } else {
        handled = false;
      }
    }

    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, {
    phase: "before",
    enabled: !!windowMode,
    allowEditable: true,
    interceptNative: true,
  });

  return {
    activeLayout,
    nativeWindowModePanelRect,
    selectWindowModePane,
    startWindowMode,
    updateWindowModePreviewLayout,
    windowMode,
    windowModeDockMovePreview,
  };
}
