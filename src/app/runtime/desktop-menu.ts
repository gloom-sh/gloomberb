import { useEffect, type Dispatch } from "react";
import { notifyGridlockComplete } from "../../plugins/gridlock-notification";
import { gridlockAllPanes } from "../../plugins/pane-manager";
import type { PluginRegistry } from "../../plugins/registry";
import type { AppAction, AppState } from "../../state/app/context";
import type { DesktopApplicationMenuBridge } from "../../types/desktop-menu";
import type { DesktopWindowBridge } from "../../types/desktop-window";
import type { RendererHost } from "../../ui/host";

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
      switch (command.type) {
        case "open-command-bar":
          dispatch({ type: "SET_COMMAND_BAR", open: true, query: command.query });
          break;
        case "open-plugin-workflow":
          pluginRegistry.openPluginCommandWorkflowFn(command.commandId);
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
          dispatch({ type: "SET_LAYOUT_MARKETPLACE", open: true });
          break;
        case "layout-undo":
          dispatch({ type: "UNDO_LAYOUT" });
          break;
        case "layout-redo":
          dispatch({ type: "REDO_LAYOUT" });
          break;
        case "layout-gridlock": {
          const { width, height } = pluginRegistry.getTermSizeFn();
          pluginRegistry.updateLayoutFn(gridlockAllPanes(
            stateRef.current.config.layout,
            { x: 0, y: 0, width, height },
            pluginRegistry.panes,
          ));
          notifyGridlockComplete(pluginRegistry.notify.bind(pluginRegistry), () => {
            dispatch({ type: "UNDO_LAYOUT" });
          });
          break;
        }
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
