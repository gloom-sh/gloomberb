import { createPaneDiscoveryContext } from "../cli/pane-functions/discovery";
import { getLoadablePlugins } from "../plugins/catalog";
import { createDefaultConfig } from "../types/config";
import type { GloomPlugin, PaneDef } from "../types/plugin";

/**
 * Every built-in pane definition, the panes a plugin registers in `setup()`
 * included, as `gloom catalog` finds them. `dispose` stops the plugins
 * that were set up.
 */
export async function loadBuiltinPanes(): Promise<{ panes: Map<string, PaneDef>; dispose: () => void }> {
  const config = createDefaultConfig("/gloom");
  const { panes, paneTemplates: _templates, ...discovery } = createPaneDiscoveryContext({
    getConfig: () => config,
    panes: new Map(getLoadablePlugins().flatMap((plugin) => plugin.panes ?? []).map((pane) => [pane.id, pane])),
  });
  const started: GloomPlugin[] = [];
  const dispose = () => {
    for (const plugin of started.splice(0).reverse()) plugin.dispose?.();
  };
  try {
    for (const plugin of getLoadablePlugins()) {
      started.push(plugin);
      await plugin.setup?.(discovery);
    }
  } catch (error) {
    dispose();
    throw error;
  }
  return { panes, dispose };
}
