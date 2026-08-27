import type { PluginRegistry } from "../plugins/registry";
import type { PaneInstanceConfig } from "../types/config";
import { parseSharePayload, type PaneShareData, type SharePayload } from "./payload";

export function buildPaneSharePayload(
  pluginRegistry: PluginRegistry,
  pane: PaneInstanceConfig,
  paneState: Record<string, unknown> = {},
): Extract<SharePayload, { kind: "pane" }> | null {
  for (const template of pluginRegistry.paneTemplates.values()) {
    if (template.paneId !== pane.paneId || !template.publicShare) continue;
    const snapshot = template.publicShare.serialize({ pane, paneState });
    if (!snapshot) continue;
    const payload = parseSharePayload({
      kind: "pane",
      data: {
        version: 1,
        templateId: template.id,
        title: snapshot.title,
        description: snapshot.description ?? template.description,
        data: snapshot.data,
      },
    });
    return payload?.kind === "pane" ? payload : null;
  }
  return null;
}

export async function openPaneShare(
  pluginRegistry: PluginRegistry,
  share: PaneShareData,
): Promise<void> {
  const template = pluginRegistry.paneTemplates.get(share.templateId);
  if (!template?.publicShare) throw new Error("This shared pane is unavailable in this version of Gloomberb.");
  const options = template.publicShare.restore(share.data);
  if (!options) throw new Error("This shared pane contains invalid settings.");
  await pluginRegistry.createPaneFromTemplateAsyncFn(template.id, options);
}
