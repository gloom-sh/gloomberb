import type { PluginRegistry } from "../plugins/registry";
import type { AppConfig, PaneInstanceConfig } from "../types/config";
import type { TickerRecord } from "../types/ticker";

/** Keys a pane names a portfolio or a broker account by. */
const ACCOUNT_KEY = /collection|portfolio|account|broker/i;

interface PersonalPaneSource {
  registry: Pick<PluginRegistry, "panes" | "brokers" | "getPanePluginId" | "getBrokerPluginId">;
  instance: Pick<PaneInstanceConfig, "paneId" | "params" | "settings">;
  paneState?: Readonly<Record<string, unknown>>;
  /** The ticker the pane shows, when it shows one. */
  symbol?: string | null;
  config: Pick<AppConfig, "portfolios" | "brokerInstances">;
  tickers?: ReadonlyMap<string, TickerRecord>;
}

function accountValues(record: Readonly<Record<string, unknown>> | undefined): string[] {
  if (!record) return [];
  return Object.entries(record).flatMap(([key, value]) => {
    if (!ACCOUNT_KEY.test(key)) return [];
    if (typeof value === "string") return [value];
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  });
}

/**
 * Whether a pane shows the user's holdings, balances or account data, so its
 * contents are asked about before they leave the device. Read from what every
 * pane already declares, with no list of panes to keep up to date:
 *
 * - it keeps fields to itself when shared (`portableShare.private`): the
 *   portfolio, account, broker, chat, team and thesis panes, and Ask Gloom;
 * - its plugin brings a broker, as an external broker plugin's panes do;
 * - it shows a ticker the user holds (a research pane lists the position);
 * - it is set to one of the user's portfolios or broker connections.
 */
export function paneShowsPersonalData({
  registry,
  instance,
  paneState,
  symbol,
  config,
  tickers,
}: PersonalPaneSource): boolean {
  const def = registry.panes.get(instance.paneId);
  if (def?.portableShare?.private) return true;

  const pluginId = registry.getPanePluginId(instance.paneId);
  if (pluginId && [...registry.brokers.keys()].some((brokerId) => registry.getBrokerPluginId(brokerId) === pluginId)) {
    return true;
  }

  const held = symbol ? tickers?.get(symbol)?.metadata.positions : undefined;
  if (held?.some((position) => position.shares !== 0)) return true;

  const accounts = new Set([
    ...config.portfolios.map((portfolio) => portfolio.id),
    ...config.brokerInstances.map((instance) => instance.id),
  ]);
  return [instance.params, instance.settings, paneState]
    .flatMap(accountValues)
    .some((value) => accounts.has(value));
}
