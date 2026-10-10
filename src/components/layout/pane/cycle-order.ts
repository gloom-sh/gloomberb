import { getDockedPaneIds } from "../../../layout/pane-manager";
import type { PluginRegistry } from "../../../plugins/registry";
import { findPaneInstance, type LayoutConfig } from "../../../types/config";
import { collectDisabledPaneIds } from "../shell/visible-layout";

export function getVisiblePaneCycleOrder(
  layout: LayoutConfig,
  pluginRegistry: PluginRegistry,
  disabledPlugins: readonly string[],
): string[] {
  const disabledTypes = collectDisabledPaneIds(pluginRegistry, disabledPlugins);
  const isVisiblePane = (instanceId: string) => {
    const instance = findPaneInstance(layout, instanceId);
    return !!instance
      && !disabledTypes.has(instance.paneId)
      && pluginRegistry.panes.has(instance.paneId);
  };

  return [
    ...getDockedPaneIds(layout),
    ...layout.floating.map((entry) => entry.instanceId),
  ].filter(isVisiblePane);
}
