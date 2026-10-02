import { useEffect, type Dispatch } from "react";
import { tidyWindows } from "../../layout/pane-manager";
import type { PluginRegistry } from "../../plugins/registry";
import type { AppAction, AppState } from "../../state/app/context";
import type { DesktopApplicationMenuBridge } from "../../types/desktop-menu";
import type { DesktopWindowBridge } from "../../types/desktop-window";
import { isDialogOpen } from "../../ui/dialog-stack";
import type { RendererHost } from "../../ui/host";
import { recordFunctionOpen } from "../../telemetry/usage-counts";

const OPENS_OVER_DIALOGS = new Set<string>(["open-command-bar", "open-plugin-workflow", "open-builtin-workflow"]);

export function useDesktopApplicationMenuRuntime({
  desktopApplicationMenuBridge,
  desktopWindowKind,
  dispatch,
  pluginRegistry,
  rendererHost,
  runUpdateCheck,
  stateRef,
}: {
  desktopApplicationMenuBridge?: DesktopApplicationMenuBridge;
  desktopWindowKind?: DesktopWindowBridge["kind"];
  dispatch: Dispatch<AppAction>;
  pluginRegistry: PluginRegistry;
  rendererHost: RendererHost;
  runUpdateCheck: (manual?: boolean) => Promise<void>;
  stateRef: { current: AppState };
}) {
  useEffect(() => {
    if (desktopWindowKind !== "main" || !desktopApplicationMenuBridge) return;
    return desktopApplicationMenuBridge.subscribe((command) => {
      // The native menu stays reachable over a dialog, accelerators included.
      // A bar opened there would sit over the dialog without its keys, and Esc
      // would close the dialog under it; a form would stack over one the user
      // has not finished. Both wait for the dialog to close.
      if (OPENS_OVER_DIALOGS.has(command.type) && isDialogOpen()) return;
      switch (command.type) {
        case "open-command-bar":
          dispatch({ type: "SET_COMMAND_BAR", open: true, query: command.query });
          break;
        case "open-plugin-workflow":
          pluginRegistry.openPluginCommandWorkflow(command.commandId);
          break;
        case "open-builtin-workflow":
          pluginRegistry.openBuiltInWorkflow(command.actionId);
          break;
        case "open-url":
          void rendererHost.openExternal(command.url).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            pluginRegistry.notify({ body: `Failed to open link: ${message}`, type: "error" });
          });
          break;
        case "check-for-updates":
          void runUpdateCheck(true);
          break;
        case "toggle-status-bar":
          dispatch({ type: "TOGGLE_STATUS_BAR" });
          break;
        case "open-layout-gallery":
          recordFunctionOpen({ shortcut: "LAY", externalPluginId: null });
          pluginRegistry.showPane("layout-marketplace");
          break;
        case "quit":
          // Through the view, so what was counted is sent before the app goes.
          rendererHost.requestExit();
          break;
        case "layout-undo":
          dispatch({ type: "UNDO_LAYOUT" });
          break;
        case "layout-redo":
          dispatch({ type: "REDO_LAYOUT" });
          break;
        case "layout-gridlock":
          tidyWindows({
            layout: stateRef.current.config.layout,
            size: pluginRegistry.getTermSize(),
            paneTypes: pluginRegistry.panes,
            apply: pluginRegistry.updateLayout,
            notify: pluginRegistry.notify,
            onRevert: () => dispatch({ type: "UNDO_LAYOUT" }),
          });
          break;
      }
    });
  }, [
    desktopApplicationMenuBridge,
    desktopWindowKind,
    dispatch,
    pluginRegistry,
    rendererHost,
    runUpdateCheck,
    stateRef,
  ]);
}
