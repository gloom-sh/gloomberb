import {
  removeUnavailablePaneTypes,
  restoreHiddenPanes,
  type PaneTypeAvailability,
} from "../../../layout/pane-manager";
import type { PluginRegistry } from "../../../plugins/registry";
import type { LayoutConfig, PaneInstanceConfig } from "../../../types/config";

/** The pane types of every plugin that is switched off. */
export function collectDisabledPaneIds(
  pluginRegistry: Pick<PluginRegistry, "getPluginPaneIds">,
  disabledPlugins: readonly string[],
): Set<string> {
  const paneIds = new Set<string>();
  for (const pluginId of new Set(disabledPlugins)) {
    for (const paneId of pluginRegistry.getPluginPaneIds(pluginId)) paneIds.add(paneId);
  }
  return paneIds;
}

export function resolveShellVisibleLayout(
  layout: LayoutConfig,
  disabledPaneIds: ReadonlySet<string>,
  registeredPaneIds: PaneTypeAvailability,
): LayoutConfig {
  return removeUnavailablePaneTypes(
    layout,
    registeredPaneIds,
    { disabledPaneIds },
  );
}

/** A pane the shell leaves off screen: its plugin is off, or nothing registered its type. */
function isShellHiddenPane(
  instance: PaneInstanceConfig,
  disabledPaneIds: ReadonlySet<string>,
  registeredPaneIds: PaneTypeAvailability,
): boolean {
  const registered = typeof registeredPaneIds === "function"
    ? !!registeredPaneIds(instance.paneId)
    : registeredPaneIds.has(instance.paneId);
  return !registered || disabledPaneIds.has(instance.paneId);
}

/**
 * What to save after an edit made on the visible layout: the edit, with every
 * pane the shell hid put back from the saved layout.
 */
export function restoreShellHiddenPanes(
  saved: LayoutConfig,
  edited: LayoutConfig,
  disabledPaneIds: ReadonlySet<string>,
  registeredPaneIds: PaneTypeAvailability,
): LayoutConfig {
  return restoreHiddenPanes(
    saved,
    edited,
    (instance) => isShellHiddenPane(instance, disabledPaneIds, registeredPaneIds),
  );
}
