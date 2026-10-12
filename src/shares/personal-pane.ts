import type { ResolvedPane } from "../layout/pane-manager";
import { getPaneSettings } from "../pane-settings";
import type { PluginRegistry } from "../plugins/registry";
import { resolveCollectionForPane, resolveTickerForPane, type AppState } from "../state/app/context";
import type { LayoutConfig } from "../types/config";
import type { PanePersonalData, PanePersonalDataContext } from "../types/plugin";
import { resolvePanePersonalData } from "./pane-image";

export interface PanePersonalDataSource {
  registry: Pick<PluginRegistry, "brokers" | "getPanePluginId" | "getBrokerPluginId">;
  state: AppState;
  /** The layout the pane is in, for its `personalData` rule. */
  layout: LayoutConfig;
  pane: Pick<ResolvedPane, "instance" | "def">;
}

/** What a pane shows now, for its `personalData` rule. */
function personalDataContext({ state, layout, pane }: Omit<PanePersonalDataSource, "registry">): PanePersonalDataContext {
  const paneId = pane.instance.instanceId;
  return {
    config: state.config,
    layout,
    paneId,
    paneType: pane.instance.paneId,
    pane: pane.instance,
    settings: getPaneSettings(pane.instance),
    paneState: state.paneState[paneId] ?? {},
    activeTicker: resolveTickerForPane(state, paneId),
    activeCollectionId: resolveCollectionForPane(state, paneId),
    tickers: state.tickers,
  };
}

/** Whether the plugin that owns a pane also connects a broker. */
function ownerConnectsBroker(registry: PanePersonalDataSource["registry"], paneType: string): boolean {
  const owner = registry.getPanePluginId(paneType);
  return !!owner && [...registry.brokers.keys()].some((brokerType) => registry.getBrokerPluginId(brokerType) === owner);
}

/**
 * The personal data a pane shows now, from its `PaneDef.personalData` and
 * nothing else; null for market data. The one answer to "does this pane show
 * the person's own data, so ask before it leaves the device": sharing its
 * picture to chat and attaching it to an Ask Gloom question both read it
 * here, from the same context.
 */
export function panePersonalData({ registry, ...source }: PanePersonalDataSource): PanePersonalData | null {
  return resolvePanePersonalData(source.pane.def, personalDataContext(source), {
    ownerConnectsBroker: ownerConnectsBroker(registry, source.pane.def.id),
  });
}
