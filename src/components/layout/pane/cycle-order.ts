import { getDockedPaneIds } from "../../../layout/pane-manager";
import type { PluginRegistry } from "../../../plugins/registry";
import { findPaneInstance, type LayoutConfig } from "../../../types/config";

function disabledPaneTypes(pluginRegistry: PluginRegistry, disabledPlugins: readonly string[]): Set<string> {
  const paneTypes = new Set<string>();
  for (const pluginId of disabledPlugins) {
    for (const paneId of pluginRegistry.getPluginPaneIds(pluginId)) {
      paneTypes.add(paneId);
    }
  }
  return paneTypes;
}

export function getVisiblePaneCycleOrder(
  layout: LayoutConfig,
  pluginRegistry: PluginRegistry,
  disabledPlugins: readonly string[],
): string[] {
  const disabledTypes = disabledPaneTypes(pluginRegistry, disabledPlugins);
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
