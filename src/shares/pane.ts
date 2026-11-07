import { logFailure } from "../utils/log-failure";
import {
  publishableMarketplacePane,
} from "./portable-layout";
import type { PluginRegistry } from "../plugins/registry";
import type { PaneInstanceConfig } from "../types/config";
import type { PaneDef, PaneTemplateDef } from "../types/plugin";
import type { TickerRecord } from "../types/ticker";
import type { ShareItem } from "./item";
import { parseSharePayload, type PaneShareData, type SharePayload } from "./payload";

export function buildPaneSharePayload(
  pluginRegistry: { panes: ReadonlyMap<string, PaneDef>; paneTemplates: ReadonlyMap<string, PaneTemplateDef> },
  pane: PaneInstanceConfig,
  paneState: Record<string, unknown> = {},
  resolvedTicker?: string | null,
  tickers?: ReadonlyMap<string, TickerRecord>,
  pinnedTime?: number | null,
  /** What the pane is on (pane-item.ts), kept beside its settings. */
  item?: ShareItem | null,
): Extract<SharePayload, { kind: "pane" }> | null {
  const def = pluginRegistry.panes.get(pane.paneId);
  if (!def) return null;
  try {
    const layout = publishableMarketplacePane(
      pane,
      paneState,
      pluginRegistry.panes,
      resolvedTicker,
      { tickers, pinnedTime },
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
      ...(item ? { item } : {}),
    });
    return payload?.kind === "pane" ? payload : null;
  } catch (error) {
    logFailure("shares.pane", "Building a pane share failed")(error);
    return null;
  }
}

export async function openPaneShare(
  pluginRegistry: PluginRegistry,
  share: PaneShareData,
): Promise<void> {
  if (share.version === 2) {
    await pluginRegistry.openPortablePaneShareAsync(share.layout);
    return;
  }
  const template = pluginRegistry.paneTemplates.get(share.templateId);
  if (!template?.publicShare) throw new Error("This shared pane is unavailable in this version of Gloom.");
  const options = template.publicShare.restore(share.data);
  if (!options) throw new Error("This shared pane contains invalid settings.");
  await pluginRegistry.createPaneFromTemplateAsync(template.id, options);
}
