import { useCallback } from "react";
import type { DesktopWindowBridge } from "../../../../types/desktop-window";
import {
  applyDrop,
  floatPane,
  gridlockAllPanes,
  isPaneInLayout,
  removeFloatingPanes,
  removePane,
  type ResolvedPane,
} from "../../../../plugins/pane-manager";
import type { PluginRegistry } from "../../../../plugins/registry";
import type { LayoutConfig } from "../../../../types/config";
import type { RendererHost } from "../../../../ui";
import { capturePaneScreenshotPngBase64 } from "../../../../utils/dom-screenshot";
import {
  exportPaneTableCsv,
  hasPaneTableExporter,
} from "../../../../state/pane-table-export-registry";

function removedFocusRestoreOptions(
  layout: LayoutConfig,
  currentFocusedPaneId: string | null,
  paneId: string | null,
): { focusedPaneId: string } | undefined {
  if (currentFocusedPaneId && isPaneInLayout(layout, currentFocusedPaneId)) return undefined;
  return paneId && isPaneInLayout(layout, paneId) ? { focusedPaneId: paneId } : undefined;
}

interface UseShellPaneActionsOptions {
  closePaneMenu: () => void;
  contentHeight: number;
  desktopWindowBridge?: DesktopWindowBridge;
  focusedPaneId: string | null;
  focusPane: (paneId: string) => void;
  nativePaneChrome: boolean;
  paneMap: Map<string, ResolvedPane>;
  persistLayout: (nextLayout: LayoutConfig, options?: { pushHistory?: boolean; focusedPaneId?: string | null }) => void;
  previousFocusedPaneId: string | null;
  pluginRegistry: PluginRegistry;
  rendererHost: RendererHost;
  visibleLayout: LayoutConfig;
  width: number;
}

export function useShellPaneActions({
  closePaneMenu,
  contentHeight,
  desktopWindowBridge,
  focusedPaneId,
  focusPane,
  nativePaneChrome,
  paneMap,
  persistLayout,
  previousFocusedPaneId,
  pluginRegistry,
  rendererHost,
  visibleLayout,
  width,
}: UseShellPaneActionsOptions) {
  const openPaneSettings = useCallback((paneId: string) => {
    pluginRegistry.openPaneSettingsFn(paneId);
    closePaneMenu();
  }, [closePaneMenu, pluginRegistry]);

  const copyPaneScreenshot = useCallback(async (paneId: string) => {
    closePaneMenu();
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!rendererHost.copyPngImage) {
        throw new Error("Image clipboard is unavailable.");
      }
      const screenshot = await capturePaneScreenshotPngBase64(paneId);
      await rendererHost.copyPngImage(screenshot.pngBase64);
      pluginRegistry.notify({ body: "Pane screenshot copied", type: "success" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not copy pane screenshot.";
      pluginRegistry.notify({ body: message, type: "error" });
    }
  }, [closePaneMenu, pluginRegistry, rendererHost]);

  const canExportPaneCsv = useCallback((paneId: string) => {
    const pane = paneMap.get(paneId);
    return pane?.def.tableExport === true && hasPaneTableExporter(paneId);
  }, [paneMap]);

  const exportPaneCsv = useCallback(async (paneId: string) => {
    closePaneMenu();
    const pane = paneMap.get(paneId);
    if (!pane) return;
    await exportPaneTableCsv(
      paneId,
      pane.instance.title ?? pane.def.name,
      pluginRegistry.notify,
    );
  }, [closePaneMenu, paneMap, pluginRegistry]);

  const exportFocusedPaneCsv = useCallback(() => {
    if (!focusedPaneId || !canExportPaneCsv(focusedPaneId)) return false;
    void exportPaneCsv(focusedPaneId);
    return true;
  }, [canExportPaneCsv, exportPaneCsv, focusedPaneId]);

  const closeFocusedPane = useCallback(() => {
    if (!focusedPaneId || !isPaneInLayout(visibleLayout, focusedPaneId)) return false;
    const nextLayout = removePane(visibleLayout, focusedPaneId);
    persistLayout(nextLayout, removedFocusRestoreOptions(nextLayout, focusedPaneId, previousFocusedPaneId));
    return true;
  }, [focusedPaneId, persistLayout, previousFocusedPaneId, visibleLayout]);

  const closeAllFloatingPanes = useCallback(() => {
    if (visibleLayout.floating.length === 0) return false;
    const nextLayout = removeFloatingPanes(visibleLayout);
    persistLayout(nextLayout, removedFocusRestoreOptions(nextLayout, focusedPaneId, previousFocusedPaneId));
    return true;
  }, [focusedPaneId, persistLayout, previousFocusedPaneId, visibleLayout]);

  const copyFocusedPaneScreenshot = useCallback(() => {
    if (!focusedPaneId || !nativePaneChrome || !rendererHost.copyPngImage) return false;
    if (!paneMap.has(focusedPaneId)) return false;
    void copyPaneScreenshot(focusedPaneId);
    return true;
  }, [copyPaneScreenshot, focusedPaneId, nativePaneChrome, paneMap, rendererHost.copyPngImage]);

  const openFocusedPaneSettings = useCallback(() => {
    if (!focusedPaneId || !pluginRegistry.hasPaneSettings(focusedPaneId)) return false;
    openPaneSettings(focusedPaneId);
    return true;
  }, [focusedPaneId, openPaneSettings, pluginRegistry]);

  const toggleFocusedPaneFloating = useCallback(() => {
    if (!focusedPaneId) return false;
    const pane = paneMap.get(focusedPaneId);
    if (!pane) return false;
    const nextLayout = pane.floating
      ? applyDrop(visibleLayout, pane.instance.instanceId, { kind: "frame", edge: "right" })
      : floatPane(visibleLayout, pane.instance.instanceId, width, contentHeight, pane.def);
    persistLayout(nextLayout);
    focusPane(pane.instance.instanceId);
    return true;
  }, [contentHeight, focusPane, focusedPaneId, paneMap, persistLayout, visibleLayout, width]);

  const popOutFocusedPane = useCallback(() => {
    if (!focusedPaneId || desktopWindowBridge?.kind !== "main" || !desktopWindowBridge.popOutPane) return false;
    if (!isPaneInLayout(visibleLayout, focusedPaneId)) return false;
    void desktopWindowBridge.popOutPane(focusedPaneId);
    return true;
  }, [desktopWindowBridge, focusedPaneId, visibleLayout]);

  const gridlockVisiblePanes = useCallback(() => {
    persistLayout(gridlockAllPanes(visibleLayout, { x: 0, y: 0, width, height: contentHeight }));
    return true;
  }, [contentHeight, persistLayout, visibleLayout, width]);

  const handleFloatingClose = useCallback((paneId: string) => {
    const nextLayout = removePane(visibleLayout, paneId);
    persistLayout(nextLayout, removedFocusRestoreOptions(nextLayout, focusedPaneId, previousFocusedPaneId));
  }, [focusedPaneId, persistLayout, previousFocusedPaneId, visibleLayout]);

  return {
    canExportPaneCsv,
    closeAllFloatingPanes,
    closeFocusedPane,
    copyFocusedPaneScreenshot,
    copyPaneScreenshot,
    exportFocusedPaneCsv,
    exportPaneCsv,
    gridlockVisiblePanes,
    handleFloatingClose,
    openFocusedPaneSettings,
    openPaneSettings,
    popOutFocusedPane,
    toggleFocusedPaneFloating,
  };
}
