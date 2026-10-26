import type { AppConfig, BrokerInstanceConfig } from "../types/config";
import type { Quote, TickerFinancials } from "../types/financials";
import type { BrokerContractRef } from "../types/instrument";
import type { Portfolio, TickerPosition, TickerRecord } from "../types/ticker";

/**
 * Broker connections the user keeps on this device (`BrokerInstanceConfig.localOnly`), and the
 * portfolios of their accounts. Cloud sync leaves the connections, those portfolios with their
 * account values, and the positions held in them out of every push, and keeps them through every
 * pull, so nothing of them reaches Gloom Cloud and a pull never removes them here.
 */
export interface LocalOnlyScope {
  instanceIds: ReadonlySet<string>;
  portfolioIds: ReadonlySet<string>;
}

/**
 * Whether a source keeps the quotes and bars it supplies on this device (`BrokerAdapter.localMarketData`),
 * by its provider id: a broker's is its broker id.
 */
export type LocalMarketDataLookup = (providerId: string) => boolean;

/** The connections the user keeps on this device, or null when there are none. */
export function localOnlyScope(config: Pick<AppConfig, "brokerInstances" | "portfolios">): LocalOnlyScope | null {
  const instanceIds = new Set(config.brokerInstances.flatMap((instance) => instance.localOnly === true ? [instance.id] : []));
  if (instanceIds.size === 0) return null;
  const scope = { instanceIds, portfolioIds: new Set<string>() };
  return { instanceIds, portfolioIds: new Set(config.portfolios.flatMap((portfolio) => isLocalOnlyPortfolio(portfolio, scope) ? [portfolio.id] : [])) };
}

export function isLocalOnlyInstance(instance: Pick<BrokerInstanceConfig, "id">, scope: LocalOnlyScope): boolean {
  return scope.instanceIds.has(instance.id);
}

export function isLocalOnlyPortfolio(portfolio: Pick<Portfolio, "id" | "brokerInstanceId">, scope: LocalOnlyScope): boolean {
  return scope.portfolioIds.has(portfolio.id) || !!portfolio.brokerInstanceId && scope.instanceIds.has(portfolio.brokerInstanceId)
    // A pulled portfolio has no profile id; its own id names the profile.
    || [...scope.instanceIds].some((id) => portfolio.id.startsWith(`broker:${id}:`));
}

function isLocalOnlyPosition(position: Pick<TickerPosition, "portfolio" | "brokerInstanceId">, scope: LocalOnlyScope): boolean {
  return scope.portfolioIds.has(position.portfolio) || !!position.brokerInstanceId && scope.instanceIds.has(position.brokerInstanceId);
}

function isLocalOnlyContract(contract: Pick<BrokerContractRef, "brokerInstanceId">, scope: LocalOnlyScope): boolean {
  return !!contract.brokerInstanceId && scope.instanceIds.has(contract.brokerInstanceId);
}

/** The config as Cloud sync may see it: without the connections kept on this device and their portfolios. */
export function publicConfig<T extends Pick<AppConfig, "brokerInstances" | "portfolios">>(config: T, scope: LocalOnlyScope | null): T {
  if (!scope) return config;
  const brokerInstances = config.brokerInstances.filter((instance) => !isLocalOnlyInstance(instance, scope));
  const portfolios = config.portfolios.filter((portfolio) => !isLocalOnlyPortfolio(portfolio, scope));
  if (brokerInstances.length === config.brokerInstances.length && portfolios.length === config.portfolios.length) return config;
  return { ...config, brokerInstances, portfolios };
}

/** The ticker as Cloud sync may see it: without positions, portfolios or contracts of connections kept on this device. */
function publicTicker(ticker: TickerRecord, scope: LocalOnlyScope | null): TickerRecord {
  if (!scope) return ticker;
  const { metadata } = ticker;
  const positions = metadata.positions.filter((position) => !isLocalOnlyPosition(position, scope));
  const portfolios = metadata.portfolios.filter((id) => !scope.portfolioIds.has(id));
  const contracts = metadata.broker_contracts?.filter((contract) => !isLocalOnlyContract(contract, scope));
  if (positions.length === metadata.positions.length && portfolios.length === metadata.portfolios.length
    && contracts?.length === metadata.broker_contracts?.length) return ticker;
  return { ...ticker, metadata: { ...metadata, positions, portfolios, ...(contracts ? { broker_contracts: contracts } : {}) } };
}

export function publicTickers(tickers: Map<string, TickerRecord>, scope: LocalOnlyScope | null): Map<string, TickerRecord> {
  if (!scope) return tickers;
  return new Map([...tickers].map(([symbol, ticker]) => [symbol, publicTicker(ticker, scope)]));
}

/** The quote fields sync uploads, any of which a source that keeps its market data local may have supplied. */
const SYNCED_QUOTE_FIELDS = ["price", "change", "changePercent", "previousClose"] as const;

function isLocalQuote(quote: Quote, isLocal: LocalMarketDataLookup): boolean {
  const provenance = quote.provenance;
  const providers = [quote.providerId, provenance?.price?.providerId, ...SYNCED_QUOTE_FIELDS.map((field) => provenance?.fields?.[field]?.providerId)];
  return providers.some((providerId) => !!providerId && isLocal(providerId));
}

/** The provider of stored bars, from their source key: `provider:<id>` or `broker:<broker id>:<profile>`. */
function historyProvider(sourceKey: string | undefined): string | null {
  const [kind, id] = sourceKey?.split(":") ?? [];
  return (kind === "provider" || kind === "broker") && id ? id : null;
}

/**
 * Financials as Cloud sync may upload them: without a quote or bars a source that keeps its market
 * data local supplied. Sync reads only the quote and the week's move from them.
 */
export function publicMarketData(financials: Map<string, TickerFinancials>, isLocal?: LocalMarketDataLookup): Map<string, TickerFinancials> {
  if (!isLocal) return financials;
  const output = new Map<string, TickerFinancials>();
  for (const [symbol, entry] of financials) {
    const localQuote = !!entry.quote && isLocalQuote(entry.quote, isLocal);
    const provider = historyProvider(entry.priceHistorySourceKey);
    const localBars = !!provider && isLocal(provider);
    output.set(symbol, localQuote || localBars ? { ...entry, ...(localQuote ? { quote: undefined } : {}), ...(localBars ? { priceHistory: [] } : {}) } : entry);
  }
  return output;
}

/**
 * `merged` (a list merged without the local-only entries) with this device's local-only entries
 * of `local` back where they were: each stays at its place among the others, so an unchanged list
 * comes back equal to `local`. An entry the pull brought that is local-only here is left out.
 */
export function withLocalOnlyEntries<T>(merged: readonly T[], local: readonly T[], isLocalOnly: (entry: T) => boolean): T[] {
  const incoming = merged.filter((entry) => !isLocalOnly(entry));
  const output: T[] = [];
  let next = 0;
  for (const entry of local) {
    if (isLocalOnly(entry)) output.push(entry);
    else if (next < incoming.length) output.push(incoming[next++]!);
  }
  output.push(...incoming.slice(next));
  return output;
}
