import { createPaneDiscoveryContext } from "../../src/cli/pane-functions/discovery";
import type { AppConfig } from "../../src/types/config";
import type { GloomPlugin } from "../../src/types/plugin";
import type { CatalogEntry } from "./web-app";

/** The compiled plugin's panes, including contributions made during setup. */
export async function discoverAuditPluginEntries(plugin: GloomPlugin, config: AppConfig): Promise<Array<CatalogEntry & { plugin: string }>> {
  const { panes, paneTemplates, ...context } = createPaneDiscoveryContext({
    getConfig: () => config,
    panes: new Map((plugin.panes ?? []).map((pane) => [pane.id, pane])),
    paneTemplates: new Map((plugin.paneTemplates ?? []).map((template) => [template.id, template])),
  });
  let failed = false;
  try {
    await plugin.setup?.(context);
    const entries: Array<CatalogEntry & { plugin: string }> = [];
    const templated = new Set<string>();
    for (const template of paneTemplates.values()) {
      // A plugin may expose several reports through the same pane.
      if (templated.has(template.paneId)) continue;
      templated.add(template.paneId);
      entries.push({
        token: template.shortcut?.prefix ?? template.id,
        paneId: template.paneId,
        argKind: template.shortcut?.argKind ?? null,
        plugin: plugin.id,
      });
    }
    for (const pane of panes.values()) {
      if (!templated.has(pane.id)) entries.push({ token: pane.id, paneId: pane.id, plugin: plugin.id });
    }
    return entries;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try { plugin.dispose?.(); } catch (error) { if (!failed) throw error; }
  }
}
