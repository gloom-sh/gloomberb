import type { PluginRegistry } from "../registry";
import { logFailure } from "../../utils/log-failure";

// unregister removes the registration even when cleanup throws. A later
// no-op cannot confirm that its background work stopped. Keep that uncertainty
// with this runtime, across pane remounts, until a fresh registry starts.
const failedStops = new WeakMap<PluginRegistry, Set<string>>();

export function deactivatePluginForRemoval(registry: PluginRegistry, pluginId: string): void {
  const failure = "Plugin could not be stopped. Restart Gloomberb before removing it.";
  if (failedStops.get(registry)?.has(pluginId)) throw new Error(failure);
  if (!registry.allPlugins.has(pluginId)) return;
  try {
    registry.unregister(pluginId);
  } catch (error) {
    const failed = failedStops.get(registry) ?? new Set<string>();
    failed.add(pluginId);
    failedStops.set(registry, failed);
    logFailure("plugin-removal", "Plugin cleanup before removal failed")(error);
    throw new Error(failure);
  }
}
