import {
  publishableMarketplacePane,
} from "../layout-marketplace/payload";
import type { PluginRegistry } from "../plugins/registry";
import type { PaneInstanceConfig } from "../types/config";
import { parseSharePayload, type PaneShareData, type SharePayload } from "./payload";

export function buildPaneSharePayload(
  pluginRegistry: PluginRegistry,
  pane: PaneInstanceConfig,
  paneState: Record<string, unknown> = {},
  resolvedTicker?: string | null,
): Extract<SharePayload, { kind: "pane" }> | null {
  const def = pluginRegistry.panes.get(pane.paneId);
  if (!def) return null;
  try {
    const layout = publishableMarketplacePane(
      pane,
      paneState,
      pluginRegistry.panes,
      resolvedTicker,
    );
    const instance = layout.layout.instances[0]!;
    const description = [...pluginRegistry.paneTemplates.values()]
      .find((template) => template.paneId === pane.paneId)?.description;
    const payload = parseSharePayload({
      kind: "pane",
      data: {
        version: 2,
        title: instance.title ?? def.name,
        ...(description ? { description } : {}),
        layout,
      },
    });
    return payload?.kind === "pane" ? payload : null;
  } catch {
    return null;
  }
}

export async function openPaneShare(
  pluginRegistry: PluginRegistry,
  share: PaneShareData,
): Promise<void> {
  if (share.version === 2) {
    await pluginRegistry.openPortablePaneShareAsyncFn(share.layout);
    return;
  }
  const template = pluginRegistry.paneTemplates.get(share.templateId);
  if (!template?.publicShare) throw new Error("This shared pane is unavailable in this version of Gloomberb.");
  const options = template.publicShare.restore(share.data);
  if (!options) throw new Error("This shared pane contains invalid settings.");
  await pluginRegistry.createPaneFromTemplateAsyncFn(template.id, options);
}
