import { saveConfigImmediately, scheduleConfigSave } from "../state/config-save-scheduler";
import { persistTickerCleanup } from "../state/ticker-cleanup";
import { hasPendingTickerWrites } from "../data/ticker-writes";
import { normalizeStoredBaseCurrency } from "../utils/base-currency";
import { debugLog } from "../utils/debug-log";
import { fnv1aHex, stableStringify } from "../utils/hash";
import type { AppConfig, BrokerInstanceConfig, SavedLayout } from "../types/config";
import type { PricePoint, TickerFinancials } from "../types/financials";
import type { Portfolio, TickerMetadata, TickerPosition, TickerRecord, Watchlist } from "../types/ticker";
import type { BrokerAccount } from "../types/trading";
import { hydrateTickerMetadata } from "../tickers/metadata";
import type { SyncContributor } from "./types";
import { convertCurrency } from "../utils/format";
import { fxRateCurrencies } from "../utils/currency-units";
import { getSharedMarketDataCoordinator, resolveEntryValue } from "../market-data/coordinator";
import {
  computeDatedBeta,
  resolveDatedReturns,
  computeWeightedPortfolioReturns,
  syntheticAccountUnsupportedReason,
  syntheticPositionUnsupportedReason,
  type DatedReturn,
  type ReturnHistoryResult,
  type WeightedReturnSeries,
} from "../plugins/builtin/analytics/metrics";
import {
  getSyncedProfileAnalytics,
  setSyncedProfileAnalytics,
} from "./profile-analytics";
import {
  addLegacyBuiltinDisabledPluginAliases,
  addLegacyBuiltinPluginOwnerAliases,
  decodeBuiltinDisabledPluginIds,
  encodeBuiltinDisabledPluginIds,
  normalizeBuiltinPluginStateMap,
} from "../plugins/ownership";
import { isFiniteNumber, isRecord, recordOrNull } from "../utils/guards";
import { getBrokerInstance } from "../utils/broker-instances";
import { withoutMissingWatchlists } from "../portfolio/mutations";
import { mergeSuffixedListings, moveTargetWeights } from "../portfolio/suffixed-listings";
import { positionContractMultiplier } from "../portfolio/position-metrics";
import { reportTelemetryConfig } from "../telemetry/live-config";
import {
  clearLeftoverBrokerHoldings,
  knownBrokerHoldings,
  type KnownBrokerHoldings,
} from "../brokers/broker-portfolio-sync";
import {
  isLocalOnlyInstance,
  isLocalOnlyPortfolio,
  localOnlyScope,
  publicConfig,
  publicMarketData,
  publicTickers,
  withLocalOnlyEntries,
  type LocalOnlyScope,
} from "./local-only";

/**
 * What a saved layout mirrors from the live session rather than from the
 * workspace the user arranged. None of it crosses the network: it is the view
 * this device is looking at right now, not a layout two devices should agree
 * on. Syncing it made every poll hand each client the other's open detail,
 * cursor and scroll position, and each apply pushed the view straight back.
 */
const SESSION_SAVED_LAYOUT_KEYS = ["paneState", "focusedPaneId", "activePanel"] as const;

/** Together these are the workspace: the tabs, the one showing, and its arrangement. */
const LAYOUT_SYNC_KEYS = ["layout", "layouts", "activeLayoutIndex"] as const;

const SENSITIVE_KEY_PATTERN = /(token|secret|password|credential|private|api[_-]?key|access[_-]?key|refresh[_-]?key|session|cookie|dataDir|path|directory|localPath)/i;

const log = debugLog.createLogger("sync");

function sanitizeUnknown(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeUnknown).filter((entry) => entry !== undefined);
  }
  if (!isRecord(value)) return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) continue;
    const sanitized = sanitizeUnknown(child);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

/**
 * Puts back what `sanitizeUnknown` keeps off the wire. A pulled config never
 * carries a token, password, key or local path, so taking it as-is deleted
 * them on this device: any plugin setting changed elsewhere (an alert, a
 * price level) wiped every plugin's saved credentials, and the user had to
 * paste them again. Those values belong to this device, so they always win.
 */
function withLocalSensitiveValues(
  pulled: Record<string, unknown>,
  local: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = { ...pulled };
  for (const [key, localChild] of Object.entries(local)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      output[key] = localChild;
    } else if (isRecord(output[key]) && isRecord(localChild)) {
      output[key] = withLocalSensitiveValues(output[key] as Record<string, unknown>, localChild);
    }
  }
  return output;
}

function withLocalPluginSecrets(
  pulled: AppConfig["pluginConfig"],
  local: AppConfig["pluginConfig"],
): AppConfig["pluginConfig"] {
  const next = { ...pulled };
  for (const [pluginId, localState] of Object.entries(local)) {
    if (!isRecord(localState)) continue;
    // A plugin the other device has no settings for still keeps its secrets here.
    const merged = withLocalSensitiveValues(next[pluginId] ?? {}, localState);
    if (pluginId in next || Object.keys(merged).length > 0) next[pluginId] = merged;
  }
  return next;
}

function sanitizePortfolio(portfolio: Portfolio): Portfolio {
  return {
    id: portfolio.id,
    name: portfolio.name,
    description: portfolio.description,
    currency: portfolio.currency,
    ...(portfolio.fixedCurrency ? { fixedCurrency: true } : {}),
    brokerId: portfolio.brokerId,
    lastSyncedAt: portfolio.lastSyncedAt,
    // Cash and targets are the user's own entries: a pulled portfolio without
    // them would erase them on this device.
    ...(portfolio.cash ? { cash: { ...portfolio.cash } } : {}),
    ...(portfolio.targetWeights ? { targetWeights: { ...portfolio.targetWeights } } : {}),
    ...(portfolio.importedFrom ? {
      importedFrom: {
        ...portfolio.importedFrom,
        ...(portfolio.importedFrom.weights ? { weights: { ...portfolio.importedFrom.weights } } : {}),
      },
    } : {}),
  };
}

function brokerAccountIdFromPortfolioId(portfolioId: string): string | undefined {
  const [kind, instanceId, ...accountParts] = portfolioId.split(":");
  if (kind !== "broker" || !instanceId) return undefined;
  const accountId = accountParts.join(":").trim();
  return accountId && accountId !== "default" ? accountId : undefined;
}

function brokerPortfolioKey(brokerId: string | undefined, accountId: string | undefined): string | undefined {
  if (!brokerId || !accountId) return undefined;
  return [brokerId, accountId].join("\u0000");
}

function portfolioSyncTimestamp(portfolio: Portfolio): number {
  return typeof portfolio.lastSyncedAt === "number" && Number.isFinite(portfolio.lastSyncedAt)
    ? portfolio.lastSyncedAt
    : 0;
}

function latestBrokerSyncByType(portfolios: Portfolio[], linkedOnly: boolean): Map<string, number> {
  const latest = new Map<string, number>();
  for (const portfolio of portfolios) {
    if (!portfolio.brokerId || (linkedOnly && !portfolio.brokerInstanceId)) continue;
    const timestamp = portfolioSyncTimestamp(portfolio);
    latest.set(portfolio.brokerId, Math.max(latest.get(portfolio.brokerId) ?? 0, timestamp));
  }
  return latest;
}

/**
 * Broker identity is deliberately excluded from cloud payloads, but it is
 * still local state that must survive applying a sanitized portfolio back to
 * this device. Match by the stable portfolio ID first, then by the account
 * suffix in that stable ID. A newer local broker snapshot also wins over old
 * unlinked records left in a cloud snapshot from before a reset.
 */
function mergeLocalBrokerPortfolioIdentity(
  localPortfolios: Portfolio[],
  syncedPortfolios: Portfolio[],
): Portfolio[] {
  const localById = new Map(localPortfolios.map((portfolio) => [portfolio.id, portfolio] as const));
  const localByBrokerAccount = new Map<string, Portfolio[]>();
  for (const portfolio of localPortfolios) {
    if (!portfolio.brokerInstanceId) continue;
    const key = brokerPortfolioKey(portfolio.brokerId, portfolio.brokerAccountId);
    if (!key) continue;
    const entries = localByBrokerAccount.get(key) ?? [];
    entries.push(portfolio);
    localByBrokerAccount.set(key, entries);
  }

  const exactIncomingIds = new Set(
    syncedPortfolios
      .map((portfolio) => portfolio.id)
      .filter((portfolioId) => localById.has(portfolioId)),
  );
  const localLatestByBroker = latestBrokerSyncByType(localPortfolios, true);
  const syncedLatestByBroker = latestBrokerSyncByType(syncedPortfolios, false);
  const merged: Portfolio[] = [];
  const seenIds = new Set<string>();

  for (const portfolio of syncedPortfolios) {
    const localByStableId = localById.get(portfolio.id);
    const accountId = brokerAccountIdFromPortfolioId(portfolio.id);
    const accountCandidates = localByBrokerAccount.get(brokerPortfolioKey(portfolio.brokerId, accountId) ?? "");
    const local = localByStableId?.brokerInstanceId && localByStableId.brokerId === portfolio.brokerId
      ? localByStableId
      : accountCandidates?.length === 1
        ? accountCandidates[0]
        : undefined;

    if (local) {
      // Prefer an exact stable-ID entry when an older duplicate appears first
      // in the remote array.
      if (portfolio.id !== local.id && exactIncomingIds.has(local.id)) continue;
      if (seenIds.has(local.id)) continue;

      const localIsNewer = portfolioSyncTimestamp(local) > portfolioSyncTimestamp(portfolio);
      merged.push(localIsNewer
        ? local
        : {
          ...portfolio,
          id: local.id,
          brokerInstanceId: local.brokerInstanceId,
          brokerAccountId: local.brokerAccountId,
        });
      seenIds.add(local.id);
      continue;
    }

    const localLatest = portfolio.brokerId ? localLatestByBroker.get(portfolio.brokerId) : undefined;
    if (localLatest !== undefined && localLatest > portfolioSyncTimestamp(portfolio)) continue;
    merged.push(portfolio);
    seenIds.add(portfolio.id);
  }

  // If the newer local broker snapshot is absent from the cloud array
  // altogether, keep it instead of treating the older array as authoritative.
  for (const portfolio of localPortfolios) {
    if (!portfolio.brokerInstanceId || seenIds.has(portfolio.id)) continue;
    const localLatest = portfolio.brokerId ? localLatestByBroker.get(portfolio.brokerId) : undefined;
    const syncedLatest = portfolio.brokerId ? syncedLatestByBroker.get(portfolio.brokerId) ?? 0 : 0;
    if (localLatest !== undefined && localLatest > syncedLatest) {
      merged.push(portfolio);
      seenIds.add(portfolio.id);
    }
  }

  return merged;
}

function sanitizeWatchlist(watchlist: Watchlist): Watchlist {
  return {
    id: watchlist.id,
    name: watchlist.name,
    description: watchlist.description,
  };
}

function sanitizeBrokerInstance(instance: BrokerInstanceConfig): Omit<BrokerInstanceConfig, "config"> {
  return {
    id: instance.id,
    brokerType: instance.brokerType,
    label: instance.label,
    connectionMode: instance.connectionMode,
    enabled: instance.enabled,
    lastSyncedAt: instance.lastSyncedAt,
  };
}

function sanitizePosition(position: TickerPosition): TickerPosition {
  return {
    portfolio: position.portfolio,
    shares: position.shares,
    avgCost: position.avgCost,
    currency: position.currency,
    dateAcquired: position.dateAcquired,
    ...(position.costFxRate != null && position.costFxCurrency ? { costFxRate: position.costFxRate, costFxCurrency: position.costFxCurrency } : {}),
    broker: position.broker,
    side: position.side,
    marketValue: position.marketValue,
    unrealizedPnl: position.unrealizedPnl,
    multiplier: position.multiplier,
    markPrice: position.markPrice,
  };
}

function brokerPositionKey(position: Pick<TickerPosition, "portfolio" | "broker" | "side">): string {
  return [position.portfolio, position.broker, position.side ?? ""].join("\u0000");
}

/** Keep broker position identity local while applying public cloud fields. */
function mergeLocalBrokerPositionIdentity(
  localPositions: TickerPosition[],
  syncedPositions: TickerPosition[],
): TickerPosition[] {
  const localByKey = new Map<string, TickerPosition[]>();
  for (const position of localPositions) {
    if (!position.brokerInstanceId) continue;
    const key = brokerPositionKey(position);
    const entries = localByKey.get(key) ?? [];
    entries.push(position);
    localByKey.set(key, entries);
  }

  return syncedPositions.map((position) => {
    const entries = localByKey.get(brokerPositionKey(position));
    const local = entries?.shift();
    if (!local) return position;

    return {
      ...position,
      brokerInstanceId: local.brokerInstanceId,
      brokerAccountId: local.brokerAccountId,
      brokerContractId: local.brokerContractId,
    };
  });
}

function pricePointTime(point: { date: Date | string | number }): number {
  const value = point.date;
  if (value instanceof Date) return value.getTime();
  return new Date(value).getTime();
}

/** The bars a week's move can start from, oldest first. */
const datedCloses = historyMemo((history) => history
  .filter((point) => Number.isFinite(point.close) && point.close > 0 && Number.isFinite(pricePointTime(point)))
  .sort((left, right) => pricePointTime(left) - pricePointTime(right)));

function weeklyQuoteMove(financials: TickerFinancials | null | undefined) {
  const quote = financials?.quote;
  if (!quote || !Number.isFinite(quote.price) || quote.price <= 0) return undefined;
  const history = datedCloses(financials?.priceHistory);
  if (history.length === 0) return undefined;
  const latestTime = Number.isFinite(quote.lastUpdated)
    ? quote.lastUpdated
    : pricePointTime(history[history.length - 1]!);
  const cutoff = latestTime - 7 * 24 * 60 * 60 * 1000;
  const reference = history.find((point) => pricePointTime(point) >= cutoff) ?? history[Math.max(0, history.length - 7)];
  if (!reference || !Number.isFinite(reference.close) || reference.close <= 0) return undefined;
  const weekChange = quote.price - reference.close;
  return {
    weekReferencePrice: reference.close,
    weekChange,
    weekChangePercent: (weekChange / reference.close) * 100,
  };
}

function sanitizeQuote(financials: TickerFinancials | null | undefined) {
  const quote = financials?.quote;
  if (!quote) return undefined;
  const week = weeklyQuoteMove(financials);
  return {
    price: Number.isFinite(quote.price) ? quote.price : undefined,
    currency: quote.currency,
    changePercent: Number.isFinite(quote.changePercent) ? quote.changePercent : undefined,
    previousClose: Number.isFinite(quote.previousClose) ? quote.previousClose : undefined,
    weekReferencePrice: week?.weekReferencePrice,
    weekChange: week?.weekChange,
    weekChangePercent: week?.weekChangePercent,
    lastUpdated: quote.lastUpdated,
  };
}

function sanitizeTickerMetadata(metadata: TickerMetadata, financials?: TickerFinancials | null): Omit<TickerMetadata, "broker_contracts"> & { quote?: ReturnType<typeof sanitizeQuote> } {
  return {
    ticker: metadata.ticker,
    exchange: metadata.exchange,
    currency: metadata.currency,
    name: metadata.name,
    sector: metadata.sector,
    industry: metadata.industry,
    assetCategory: metadata.assetCategory,
    isin: metadata.isin,
    cusip: metadata.cusip,
    portfolios: [...metadata.portfolios],
    watchlists: [...metadata.watchlists],
    positions: metadata.positions.map(sanitizePosition),
    custom: (sanitizeUnknown(metadata.custom) as Record<string, unknown>) ?? {},
    tags: [...metadata.tags],
    // What a listing's row took from a suffixed key's row, so a device that merges it later never counts a lot twice.
    ...metadata.mergedLots ? { mergedLots: metadata.mergedLots } : {},
    quote: sanitizeQuote(financials),
  };
}

function collectLayoutPayload(config: Pick<AppConfig, typeof LAYOUT_SYNC_KEYS[number]>) {
  return sanitizeUnknown({
    layout: config.layout,
    layouts: config.layouts.map(withoutSessionLayoutState),
    activeLayoutIndex: config.activeLayoutIndex,
  }) as Record<string, unknown>;
}

function collectCoreConfigPayload(config: AppConfig) {
  return sanitizeUnknown({
    configVersion: config.configVersion,
    baseCurrency: config.baseCurrency,
    refreshIntervalMinutes: config.refreshIntervalMinutes,
    portfolios: config.portfolios.map(sanitizePortfolio),
    watchlists: config.watchlists.map(sanitizeWatchlist),
    ...collectLayoutPayload(config),
    brokerInstances: config.brokerInstances.map(sanitizeBrokerInstance),
    // This build merges profiles one by one before it pushes, so a profile
    // missing from its list was removed, not one it never pulled.
    brokerInstancesMergedById: true,
    disabledPlugins: addLegacyBuiltinDisabledPluginAliases(encodeBuiltinDisabledPluginIds(config.disabledPlugins)),
    disabledSources: config.disabledSources,
    pluginConfig: addLegacyBuiltinPluginOwnerAliases(config.pluginConfig),
    theme: config.theme,
    chartPreferences: config.chartPreferences,
    valueFlashingEnabled: config.valueFlashingEnabled,
    recentTickers: config.recentTickers,
    recentCommands: config.recentCommands,
    // Completion is monotonic in synced state. A device only advertises the
    // completed state, while resumable progress and incomplete state stay local.
    onboardingComplete: config.onboardingComplete === true ? true : undefined,
    // Only whether Attention Counts is off: see mergedAttentionTelemetry.
    attentionOff: config.telemetry?.attention === false,
  });
}

/**
 * Attention Counts off belongs to the signed-in account, not to one device:
 * an off made on another device turns it off here, and an explicit on made
 * there afterwards turns it back on. The default never overrides either. An
 * edit made here since the last sync wins, like any setting. No synced copy,
 * or one from before `attentionOff` existed, reads as not off: a device's
 * first sync takes an off already on the account, and keeps its own off
 * instead of taking an on.
 */
function mergedAttentionTelemetry(
  config: AppConfig,
  baselineConfig: AppConfig,
  payload: Record<string, unknown>,
  lastSynced: Record<string, unknown> | null,
): AppConfig["telemetry"] {
  // A copy pushed by an older build says nothing either way.
  if (typeof payload.attentionOff !== "boolean") return config.telemetry;
  const localOff = config.telemetry?.attention === false;
  if (payload.attentionOff === localOff) return config.telemetry;
  const editedHere = localOff !== (baselineConfig.telemetry?.attention === false)
    || localOff !== (lastSynced?.attentionOff === true);
  if (editedHere) return config.telemetry;
  return { ...config.telemetry, attention: !payload.attentionOff };
}

function positionValueBase(
  ticker: TickerRecord,
  position: TickerPosition,
  financials: TickerFinancials | null | undefined,
  baseCurrency: string,
  exchangeRates: Map<string, number>,
): number | null {
  const quoteCurrency = financials?.quote?.currency || position.currency || baseCurrency;
  const positionCurrency = position.currency || quoteCurrency;
  if (typeof position.marketValue === "number" && Number.isFinite(position.marketValue)) {
    return convertCurrency(Math.abs(position.marketValue), positionCurrency, baseCurrency, exchangeRates);
  }
  const hasMarkPrice = typeof position.markPrice === "number" && Number.isFinite(position.markPrice);
  const hasQuotePrice = typeof financials?.quote?.price === "number" && Number.isFinite(financials.quote.price);
  const price = hasMarkPrice ? position.markPrice : hasQuotePrice ? financials!.quote!.price : position.avgCost;
  // The multiplier the portfolio values the lot by: a future of unknown size has no value, never one at 1x.
  const multiplier = positionContractMultiplier(ticker, position);
  if (!Number.isFinite(position.shares) || typeof price !== "number" || !Number.isFinite(price) || multiplier === null) return null;
  return convertCurrency(
    Math.abs(position.shares * price * multiplier),
    hasQuotePrice && !hasMarkPrice ? quoteCurrency : positionCurrency,
    baseCurrency,
    exchangeRates,
  );
}

function pricePointTimeOrNull(point: PricePoint): number | null {
  const value = point.date;
  if (value == null) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function recentPriceHistory(history: PricePoint[], days: number): PricePoint[] {
  let latestTime = 0;
  for (const point of history) {
    const time = pricePointTimeOrNull(point);
    if (time != null && time > latestTime) latestTime = time;
  }
  if (latestTime <= 0) return [];
  const cutoff = latestTime - days * 24 * 60 * 60 * 1000;
  return history.filter((point) => {
    const time = pricePointTimeOrNull(point);
    return time != null && time >= cutoff;
  });
}

/**
 * Work derived from a bar history, kept with the history. Every sync values
 * every portfolio and quotes every filed ticker (each 15 s poll, and after
 * each workspace change), and redoing that work from each holding's bars
 * blocked the view for a quarter of a second on a few hundred holdings.
 * Bars change when a history loads again, which replaces the
 * array; a last bar extended or revised in place, or one appended, is caught
 * by its length, time and close.
 */
function historyMemo<T>(derive: (history: PricePoint[]) => T): (history: PricePoint[] | undefined) => T {
  const kept = new WeakMap<PricePoint[], { length: number; lastTime: number | null; lastClose: number | undefined; value: T }>();
  const empty = derive([]);
  return (history) => {
    if (!history || history.length === 0) return empty;
    const last = history[history.length - 1]!;
    const lastTime = pricePointTimeOrNull(last);
    const cached = kept.get(history);
    if (cached && cached.length === history.length && cached.lastTime === lastTime && cached.lastClose === last.close) return cached.value;
    const value = derive(history);
    kept.set(history, { length: history.length, lastTime, lastClose: last.close, value });
    return value;
  };
}

/** A holding's daily returns over its last year of bars. */
const lastYearReturns = historyMemo((history): ReturnHistoryResult => resolveDatedReturns(recentPriceHistory(history, 366)));

/** The holdings' beta to SPY at today's weights, worked out only when no preview supplies one. */
function holdingsBeta(series: WeightedReturnSeries[], spyReturns: DatedReturn[]): number | null {
  if (series.length === 0 || spyReturns.length === 0) return null;
  const returns = computeWeightedPortfolioReturns(series);
  return returns.length > 0 ? computeDatedBeta(returns, spyReturns) : null;
}

function collectAnalyticsByPortfolio(
  config: AppConfig,
  tickers: Map<string, TickerRecord>,
  financials: Map<string, TickerFinancials>,
  exchangeRates: Map<string, number>,
  brokerAccounts: Record<string, BrokerAccount[]>,
) {
  const output: Record<string, Record<string, unknown>> = {};
  const spySample = lastYearReturns(financials.get("SPY")?.priceHistory);
  const spyReturns = spySample.returns;
  for (const portfolio of config.portfolios) {
    const account = portfolio.brokerInstanceId && portfolio.brokerAccountId
      ? brokerAccounts[portfolio.brokerInstanceId]?.find((entry) => entry.accountId === portfolio.brokerAccountId)
      : undefined;
    let unsupported = !!syntheticAccountUnsupportedReason(account);
    let invalidHistory = false;
    const datedReturnSeries: WeightedReturnSeries[] = [];
    for (const ticker of tickers.values()) {
      const tickerFinancials = financials.get(ticker.metadata.ticker);
      const portfolioPositions = ticker.metadata.positions.filter((position) => position.portfolio === portfolio.id);
      if (portfolioPositions.length === 0) continue;
      unsupported ||= !!syntheticPositionUnsupportedReason(
        ticker, tickerFinancials?.quote?.currency || ticker.metadata.currency || config.baseCurrency, portfolio.id,
      );
      for (const position of portfolioPositions) {
        if (position.shares === 0) continue;
        const value = positionValueBase(ticker, position, tickerFinancials, config.baseCurrency, exchangeRates);
        if (value == null || !Number.isFinite(value)) {
          unsupported = true;
          continue;
        }
        const sample = lastYearReturns(tickerFinancials?.priceHistory);
        invalidHistory ||= sample.integrity != null;
        const returns = sample.returns;
        if (returns.length >= 10) datedReturnSeries.push({ weight: value, returns });
        else unsupported = true;
      }
    }
    const previewAnalytics = getSyncedProfileAnalytics(portfolio.id);
    // The broker's own returns do not depend on the holdings' price histories.
    const accountBasis = previewAnalytics?.basis === "account";
    // A weighted history of today's holdings is not the investor's actual
    // one-year account return. Only preserve an explicitly supplied preview.
    const oneYearReturn = invalidHistory && !accountBasis ? null : previewAnalytics?.oneYearReturn ?? null;
    const spyBeta = (invalidHistory && !accountBasis) || spySample.integrity ? null : previewAnalytics?.spyBeta
      ?? holdingsBeta(unsupported ? [] : datedReturnSeries, spyReturns);
    output[portfolio.id] = {
      oneYearReturn,
      spyBeta,
      basis: oneYearReturn == null && spyBeta == null ? null : previewAnalytics?.basis ?? "holdings",
    };
  }
  return output;
}

function collectAccountsByPortfolio(
  config: AppConfig,
  brokerAccounts: Record<string, BrokerAccount[]>,
) {
  const output: Record<string, Record<string, string | number>> = {};
  for (const portfolio of config.portfolios) {
    if (!portfolio.brokerInstanceId || !portfolio.brokerAccountId) continue;
    const account = brokerAccounts[portfolio.brokerInstanceId]?.find(
      (entry) => entry.accountId === portfolio.brokerAccountId,
    );
    if (!account || !Number.isFinite(account.netLiquidation)) continue;
    output[portfolio.id] = {
      currency: account.currency ?? portfolio.currency ?? config.baseCurrency,
      netLiquidation: account.netLiquidation!,
      ...(Number.isFinite(account.dailyPnl) ? { dailyPnl: account.dailyPnl! } : {}),
      ...(Number.isFinite(account.unrealizedPnl) ? { unrealizedPnl: account.unrealizedPnl! } : {}),
      ...(Number.isFinite(account.updatedAt) ? { updatedAt: account.updatedAt! } : {}),
    };
  }
  return output;
}

type SanitizedTickerMetadata = ReturnType<typeof sanitizeTickerMetadata>;

/** Only tickers the user actually filed somewhere are worth syncing. */
function isSyncableTicker(metadata: Pick<SanitizedTickerMetadata, "portfolios" | "watchlists" | "positions">): boolean {
  return metadata.portfolios.length > 0
    || metadata.watchlists.length > 0
    || metadata.positions.length > 0;
}

/**
 * USD-per-unit rates for the base currency and every currency a holding is
 * valued in, read from the same FX store the portfolio panes use. A currency
 * without a usable rate stays missing, so its holdings count as unsupported.
 */
async function loadHoldingExchangeRates(
  config: AppConfig,
  tickers: Map<string, TickerRecord>,
  financials: Map<string, TickerFinancials>,
): Promise<Map<string, number>> {
  const rates = new Map([["USD", 1]]);
  const coordinator = getSharedMarketDataCoordinator();
  if (!coordinator) return rates;
  const held: Array<string | undefined> = [config.baseCurrency];
  for (const ticker of tickers.values()) {
    if (ticker.metadata.positions.length === 0) continue;
    held.push(financials.get(ticker.metadata.ticker)?.quote?.currency);
    for (const position of ticker.metadata.positions) held.push(position.currency);
  }
  // With a minor unit's major currency, as the panes load them (GBX and ILA have no rate of their own).
  const currencies = fxRateCurrencies(held).filter((currency) => currency !== "USD");
  await Promise.all(currencies.map(async (currency) => {
    // A failed FX load must not hold back the rest of the push.
    await coordinator.loadFxRate(currency).catch(() => {});
    const rate = resolveEntryValue(coordinator.getFxEntry(currency));
    if (rate != null) rates.set(currency, rate);
  }));
  return rates;
}

function collectCoreCollectionsPayload(
  config: AppConfig,
  tickers: Map<string, TickerRecord>,
  financials: Map<string, TickerFinancials>,
  exchangeRates: Map<string, number>,
  brokerAccounts: Record<string, BrokerAccount[]>,
  /** The financials whose quotes may be uploaded: without those a source that keeps its market data local supplied. */
  quoted: Map<string, TickerFinancials> = financials,
) {
  const records = [...tickers.values()]
    .map((ticker) => sanitizeTickerMetadata(ticker.metadata, quoted.get(ticker.metadata.ticker)))
    .filter(isSyncableTicker);

  // Only the USD anchor goes on the wire, as before: readers of the snapshot
  // use any rate found here instead of fetching a current one, and a rate
  // loaded for this push would age with it.
  return {
    baseCurrency: config.baseCurrency,
    exchangeRates: { USD: 1 },
    portfolios: config.portfolios.map(sanitizePortfolio),
    watchlists: config.watchlists.map(sanitizeWatchlist),
    analyticsByPortfolio: collectAnalyticsByPortfolio(config, tickers, financials, exchangeRates, brokerAccounts),
    accountsByPortfolio: collectAccountsByPortfolio(config, brokerAccounts),
    tickers: records,
  };
}

function hydrateProfileAnalytics(payload: Record<string, unknown>): void {
  if (!isRecord(payload.analyticsByPortfolio)) return;
  for (const [portfolioId, analytics] of Object.entries(payload.analyticsByPortfolio)) {
    if (!isRecord(analytics)) continue;
    setSyncedProfileAnalytics(portfolioId, {
      oneYearReturn: typeof analytics.oneYearReturn === "number" ? analytics.oneYearReturn : null,
      spyBeta: typeof analytics.spyBeta === "number" ? analytics.spyBeta : null,
      basis: analytics.basis === "account" || analytics.basis === "holdings" ? analytics.basis : null,
    });
  }
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function isPluginStateMap(value: unknown): value is Record<string, Record<string, unknown>> {
  return isRecord(value) && Object.values(value).every(isRecord);
}

function withoutSessionLayoutState(savedLayout: SavedLayout): SavedLayout {
  if (!isRecord(savedLayout)) return savedLayout;
  if (!SESSION_SAVED_LAYOUT_KEYS.some((key) => key in savedLayout)) return savedLayout;
  const { paneState: _paneState, focusedPaneId: _focusedPaneId, activePanel: _activePanel, ...rest } = savedLayout;
  return rest;
}

/**
 * A pulled layout list describes the workspace; the session state stays with
 * this device. Entries are matched by name first so a renamed or reordered
 * list still hands each layout back its own pane state.
 */
function withLocalSessionLayoutState(
  pulled: SavedLayout[],
  local: SavedLayout[],
): SavedLayout[] {
  const localByName = new Map(local.map((savedLayout) => [savedLayout?.name, savedLayout]));
  return pulled.map((savedLayout, index) => {
    if (!isRecord(savedLayout)) return savedLayout;
    const stripped = withoutSessionLayoutState(savedLayout);
    const source = localByName.get(savedLayout.name) ?? local[index];
    if (!source) return stripped;
    return {
      ...stripped,
      paneState: source.paneState,
      focusedPaneId: source.focusedPaneId,
    };
  });
}

/** A dock tree with no stack's shown tab: like stacking order, it follows whichever pane was focused last. */
function withoutShownTabs(node: unknown): unknown {
  if (!isRecord(node) || node.kind !== "split") return node;
  const { tabs, ...rest } = node;
  return {
    ...rest,
    first: withoutShownTabs(node.first),
    second: withoutShownTabs(node.second),
    ...(tabs === undefined ? {} : { tabs: true }),
  };
}

/**
 * A layout as the user arranged it. Stacking order and the tab a stack shows
 * follow whichever pane was focused last, and a pane in its own desktop window
 * is one a terminal draws inline as a floating pane, so none of them tells two
 * copies apart.
 */
function arrangedLayout(layout: unknown): unknown {
  if (!isRecord(layout)) return layout;
  const windows = [
    ...(Array.isArray(layout.floating) ? layout.floating : []),
    ...(Array.isArray(layout.detached) ? layout.detached : []),
  ].map((entry) => {
    if (!isRecord(entry)) return entry;
    const { zIndex: _zIndex, ...rest } = entry;
    return rest;
  });
  const instanceId = (entry: unknown) => (isRecord(entry) ? String(entry.instanceId) : "");
  windows.sort((left, right) => instanceId(left).localeCompare(instanceId(right)));
  return { ...layout, dockRoot: withoutShownTabs(layout.dockRoot), floating: windows, detached: [] };
}

// Pulled and last synced payloads are compared on every sync and never change.
const layoutIntents = new WeakMap<object, string | null>();

/**
 * A key for the workspace a payload describes, equal for two copies that only
 * differ in what reflects one device, so a real edit can be told from them.
 * Null when the payload holds no complete workspace.
 */
function layoutIntent(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.layouts)) return null;
  if (!LAYOUT_SYNC_KEYS.every((key) => key in payload)) return null;
  const cached = layoutIntents.get(payload);
  if (cached !== undefined) return cached;
  const intent = stableStringify(sanitizeUnknown({
    layout: arrangedLayout(payload.layout),
    layouts: payload.layouts.map((entry) => (
      isRecord(entry)
        ? { ...withoutSessionLayoutState(entry as unknown as SavedLayout), layout: arrangedLayout(entry.layout) }
        : entry
    )),
    activeLayoutIndex: payload.activeLayoutIndex,
  }));
  const key = `${fnv1aHex(intent)}:${intent.length}`;
  layoutIntents.set(payload, key);
  return key;
}

/** The workspace keys of a payload, with the time its layout was last edited when it says. */
function pickLayoutPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const picked = Object.fromEntries([...LAYOUT_SYNC_KEYS, "layoutEditedAt"].flatMap((key) => (
    key in payload ? [[key, payload[key]]] : []
  )));
  // An older build still sent the view it was looking at with each layout.
  if (Array.isArray(picked.layouts)) {
    picked.layouts = picked.layouts.map((entry) => (isRecord(entry) ? withoutSessionLayoutState(entry as unknown as SavedLayout) : entry));
  }
  return picked;
}

/**
 * What this device remembers about its workspace between syncs: when it last
 * edited it (null when that happened while the app was closed, so the time is
 * unknown), or, when it took the workspace from the cloud, that copy as synced.
 */
interface LayoutMemo {
  intent: string;
  editedAt: number | null;
  synced?: Record<string, unknown>;
}

function readLayoutMemo(value: unknown): LayoutMemo | null {
  if (!isRecord(value) || typeof value.intent !== "string") return null;
  return {
    intent: value.intent,
    editedAt: typeof value.editedAt === "number" && Number.isFinite(value.editedAt) ? value.editedAt : null,
    ...(isRecord(value.synced) ? { synced: value.synced } : {}),
  };
}

/**
 * When a pulled workspace was last edited. A copy from a build that did not
 * date edits counts as edited when it was pushed, which is never earlier.
 */
function pulledLayoutEditedAt(payload: Record<string, unknown>, pushedAt: string | undefined): number {
  if (typeof payload.layoutEditedAt === "number" && Number.isFinite(payload.layoutEditedAt)) return payload.layoutEditedAt;
  const pushed = pushedAt ? Date.parse(pushedAt) : Number.NaN;
  return Number.isFinite(pushed) ? pushed : Number.POSITIVE_INFINITY;
}

/**
 * Whether a pulled workspace replaces this device's, three ways: against the
 * copy this device last synced, the one it had when the pull started, and the
 * pulled one. Only a real edit here keeps the local copy; the pane state,
 * focus and window stacking that change on every launch never do.
 */
function shouldAdoptPulledLayout({
  local,
  atPullStart,
  lastSynced,
  pulled,
  memo,
  pulledEditedAt,
}: {
  local: string | null;
  atPullStart: string | null;
  lastSynced: string | null;
  pulled: string | null;
  memo: LayoutMemo | null;
  pulledEditedAt: number;
}): boolean {
  if (pulled === null || pulled === local) return false;
  // Edited while the pull was in flight: newer than anything it carries.
  if (local !== atPullStart) return false;
  const takenFromCloud = !!memo?.synced && memo.intent === local;
  const editedHere = lastSynced !== null && local !== lastSynced && !takenFromCloud;
  if (!editedHere) return true;
  // The cloud still holds what this device last synced: only this side changed.
  if (pulled === lastSynced) return false;
  // Both sides changed since: the later edit wins, and an undated local one loses.
  const localEditedAt = memo?.intent === local ? memo.editedAt : null;
  return localEditedAt === null || localEditedAt <= pulledEditedAt;
}

/**
 * The workspace as the cloud already has it unless this device really edited
 * it, so what only reflects this device never replaces another device's copy,
 * and a real edit goes out dated.
 */
function withLayoutProvenance(
  payload: Record<string, unknown>,
  lastSyncedPayload: unknown,
  memoValue: unknown,
): Record<string, unknown> {
  const local = layoutIntent(payload);
  if (local === null) return payload;
  const memo = readLayoutMemo(memoValue);
  if (memo?.synced && memo.intent === local) return { ...payload, ...memo.synced };
  if (isRecord(lastSyncedPayload) && layoutIntent(lastSyncedPayload) === local) {
    return { ...payload, ...pickLayoutPayload(lastSyncedPayload) };
  }
  return {
    ...payload,
    layoutEditedAt: memo?.intent === local && memo.editedAt !== null ? memo.editedAt : Date.now(),
  };
}

/**
 * Dates a workspace edit when it happens, online or not, so a later conflict
 * with another device's edit goes to the newer one.
 */
function noteLayoutEdit(config: AppConfig, lastSyncedPayload: unknown, memoValue: unknown, launch: boolean): LayoutMemo | null {
  const lastSynced = layoutIntent(lastSyncedPayload);
  if (lastSynced === null) return null;
  const local = layoutIntent(collectLayoutPayload(config));
  if (local === null || local === lastSynced) return null;
  if (readLayoutMemo(memoValue)?.intent === local) return null;
  // Seen at launch, it was made while the app was closed or just before it
  // quit; when is unknown, so it gives way to a dated edit elsewhere.
  return { intent: local, editedAt: launch ? null : Date.now() };
}

/**
 * Once this device holds the cloud's workspace, by taking it or because the
 * two already matched, it remembers that copy as synced, keyed by how it
 * looks here once applied. The next push then sends the cloud's own copy back
 * rather than this device's rendering of it.
 */
function rememberCloudLayout(
  payload: Record<string, unknown>,
  pushedAt: string | undefined,
  applied: AppConfig,
  memo: { get(): unknown; set(value: unknown): void },
  adopted: boolean,
): void {
  const local = layoutIntent(collectLayoutPayload(applied));
  if (local === null || (!adopted && local !== layoutIntent(payload))) return;
  const current = readLayoutMemo(memo.get());
  if (!adopted && current?.synced && current.intent === local) return;
  const editedAt = pulledLayoutEditedAt(payload, pushedAt);
  memo.set({
    intent: local,
    editedAt: Number.isFinite(editedAt) ? editedAt : null,
    synced: pickLayoutPayload(payload),
  } satisfies LayoutMemo);
}

interface LayoutMergeContext {
  memo?: unknown;
  /** When the pulled copy was pushed, for one from a build that did not date layout edits. */
  pushedAt?: string;
}

/** A pulled config without profiles and portfolios that are local-only here (an older build may have pushed them). */
function publicConfigPayload(payload: Record<string, unknown>, scope: LocalOnlyScope): Record<string, unknown> {
  const without = (entries: unknown, isLocal: (entry: Record<string, unknown>) => boolean) => (
    Array.isArray(entries) ? entries.filter((entry) => !isRecord(entry) || !isLocal(entry)) : entries
  );
  return {
    ...payload,
    ...("brokerInstances" in payload ? { brokerInstances: without(payload.brokerInstances, (entry) => isLocalOnlyInstance({ id: String(entry.id) }, scope)) } : {}),
    ...("portfolios" in payload ? { portfolios: without(payload.portfolios, (entry) => isLocalOnlyPortfolio(entry as unknown as Portfolio, scope)) } : {}),
  };
}

function mergeConfigPayload(
  config: AppConfig,
  payload: unknown,
  baselineConfig: AppConfig = config,
  lastSyncedPayload?: unknown,
  layoutContext: LayoutMergeContext = {},
  scope: LocalOnlyScope | null = null,
): AppConfig | null {
  if (!isRecord(payload)) return null;
  if (scope) {
    // Merged as if the local-only profiles and portfolios were not here, then put back as they were.
    const local = publicConfig(config, scope);
    const merged = mergeConfigPayload(local, publicConfigPayload(payload, scope), baselineConfig === config ? local : publicConfig(baselineConfig, scope),
      lastSyncedPayload, layoutContext);
    return merged && {
      ...merged,
      brokerInstances: withLocalOnlyEntries(merged.brokerInstances, config.brokerInstances, (instance) => isLocalOnlyInstance(instance, scope)),
      portfolios: withLocalOnlyEntries(merged.portfolios, config.portfolios, (portfolio) => isLocalOnlyPortfolio(portfolio, scope)),
    };
  }
  const next: AppConfig = { ...config };
  // Two guards, both needed. baselineConfig catches edits made while this pull
  // was in flight; lastSyncedPayload catches edits made while the app was not
  // running at all (CLI writes, offline edits), which otherwise look pristine.
  const lastSynced = isRecord(lastSyncedPayload) ? lastSyncedPayload : null;
  const localPayload = collectCoreConfigPayload(config) as Record<string, unknown>;
  const matchesLastSynced = (key: string) => (
    !lastSynced || valuesEqual(localPayload[key], lastSynced[key])
  );
  const canApply = <K extends keyof AppConfig>(key: K) => (
    valuesEqual(config[key], baselineConfig[key]) && matchesLastSynced(key as string)
  );
  const assign = <K extends keyof AppConfig>(key: K) => {
    if (key in payload && canApply(key)) {
      next[key] = payload[key as string] as AppConfig[K];
    }
  };

  assign("baseCurrency");
  // A device on an older version may still send a name or sign (Canadian dollar, CA$): it applies as its code, as a saved one loads.
  if (typeof next.baseCurrency === "string" && next.baseCurrency.trim()) next.baseCurrency = normalizeStoredBaseCurrency(next.baseCurrency);
  assign("refreshIntervalMinutes");
  if ("portfolios" in payload && canApply("portfolios")) {
    const syncedPortfolios = payload.portfolios;
    next.portfolios = Array.isArray(syncedPortfolios)
      ? mergeLocalBrokerPortfolioIdentity(config.portfolios, syncedPortfolios as Portfolio[])
      : syncedPortfolios as AppConfig["portfolios"];
  }
  assign("watchlists");
  assign("disabledSources");
  assign("theme");
  assign("chartPreferences");
  assign("valueFlashingEnabled");
  assign("recentTickers");
  assign("recentCommands");
  const telemetry = mergedAttentionTelemetry(config, baselineConfig, payload, lastSynced);
  if (telemetry !== config.telemetry) next.telemetry = telemetry;
  // Sync can complete onboarding on another device, but never reopen it.
  // Resumable progress remains local until this installation completes it.
  if (
    !config.onboardingProgress
    && config.onboardingComplete !== true
    && payload.onboardingComplete === true
    && canApply("onboardingComplete")
  ) {
    next.onboardingComplete = true;
  }

  if (
    canApply("disabledPlugins")
    && Array.isArray(payload.disabledPlugins)
    && payload.disabledPlugins.every((pluginId) => typeof pluginId === "string")
  ) {
    next.disabledPlugins = decodeBuiltinDisabledPluginIds(payload.disabledPlugins);
  }
  if (canApply("pluginConfig") && isPluginStateMap(payload.pluginConfig)) {
    next.pluginConfig = withLocalPluginSecrets(
      normalizeBuiltinPluginStateMap(payload.pluginConfig),
      config.pluginConfig,
    );
  }

  // Compared by content, not identity: the active layout mirrors pane state,
  // so a cursor settling at launch replaced it mid-pull, the pulled workspace
  // was refused, and the push that followed wrote this device's older one
  // over it on every other device.
  const localIntent = layoutIntent(localPayload);
  const adoptLayout = shouldAdoptPulledLayout({
    local: localIntent,
    atPullStart: baselineConfig === config ? localIntent : layoutIntent(collectLayoutPayload(baselineConfig)),
    lastSynced: layoutIntent(lastSynced),
    pulled: layoutIntent(payload),
    memo: readLayoutMemo(layoutContext.memo),
    pulledEditedAt: pulledLayoutEditedAt(payload, layoutContext.pushedAt),
  });
  if (adoptLayout) {
    next.layout = payload.layout as unknown as AppConfig["layout"];
    next.layouts = withLocalSessionLayoutState(payload.layouts as AppConfig["layouts"], config.layouts);
    next.activeLayoutIndex = payload.activeLayoutIndex as number;
  }

  if (Array.isArray(payload.brokerInstances)) {
    const syncedIds = Array.isArray(lastSynced?.brokerInstances) ? idsOf(lastSynced.brokerInstances) : null;
    next.brokerInstances = mergeBrokerInstances(
      config.brokerInstances,
      payload.brokerInstances as Array<Partial<BrokerInstanceConfig>>,
      canApply("brokerInstances"),
      syncedIds,
      payload.brokerInstancesMergedById === true,
    );
    if (syncedIds) next.portfolios = withoutRemovedBrokerPortfolios(config, next, syncedIds, payload.portfolios);
  }
  return next;
}

/** The entries of a pulled list that carry an id. */
function idEntries(entries: unknown): Array<{ id: string }> {
  return Array.isArray(entries)
    ? entries.flatMap((entry) => (isRecord(entry) && typeof entry.id === "string" ? [{ id: entry.id }] : []))
    : [];
}

function idsOf(entries: unknown[]): Set<string> {
  return new Set(entries.flatMap((entry) => (isRecord(entry) && typeof entry.id === "string" ? [entry.id] : [])));
}

/**
 * Takes the pulled profiles when this device has not changed its own since it
 * last synced. When it has (a broker sync alone moves `lastSyncedAt`), it keeps
 * its own, but profile by profile against the ids it last synced: one removed
 * on another device goes, one removed here stays gone, and one added elsewhere
 * arrives. Keeping the whole list instead pushed a profile removed elsewhere
 * back to every device.
 *
 * An older build that changed its own profiles pushes its whole list, without
 * a profile added here since it last pulled, so only a list merged the same
 * way (`removalsCount`) can remove one: the profile's settings never sync and
 * would be lost for good.
 */
function mergeBrokerInstances(
  local: BrokerInstanceConfig[],
  incoming: Array<Partial<BrokerInstanceConfig>>,
  localUnchanged: boolean,
  syncedIds: ReadonlySet<string> | null,
  removalsCount: boolean,
): BrokerInstanceConfig[] {
  const localById = new Map(local.map((instance) => [instance.id, instance]));
  const fromIncoming = (instance: Partial<BrokerInstanceConfig>): BrokerInstanceConfig => {
    const current = instance.id ? localById.get(instance.id) : undefined;
    return {
      id: instance.id ?? current?.id ?? crypto.randomUUID(),
      brokerType: instance.brokerType ?? current?.brokerType ?? "",
      label: instance.label ?? current?.label ?? "",
      connectionMode: instance.connectionMode ?? current?.connectionMode,
      enabled: instance.enabled ?? current?.enabled,
      lastSyncedAt: instance.lastSyncedAt ?? current?.lastSyncedAt,
      config: current?.config ?? {},
    };
  };
  if (localUnchanged) return incoming.map(fromIncoming);
  if (!syncedIds) return local;

  const incomingIds = idsOf(incoming);
  const kept = removalsCount
    ? local.filter((instance) => incomingIds.has(instance.id) || !syncedIds.has(instance.id))
    : local;
  const added = incoming.filter((instance) => (
    typeof instance.id === "string" && !localById.has(instance.id) && !syncedIds.has(instance.id)
  ));
  return kept.length === local.length && added.length === 0 ? local : [...kept, ...added.map(fromIncoming)];
}

/**
 * A broker portfolio goes with a profile the pull removed, unless the pulled
 * portfolios still list it: another device handed it to a profile it kept.
 * Only a profile this device had synced counts as removed elsewhere.
 */
function withoutRemovedBrokerPortfolios(
  config: AppConfig,
  next: AppConfig,
  syncedIds: ReadonlySet<string>,
  pulledPortfolios: unknown,
): Portfolio[] {
  const remaining = new Set(next.brokerInstances.map((instance) => instance.id));
  const removed = new Set(config.brokerInstances.flatMap((instance) => (
    syncedIds.has(instance.id) && !remaining.has(instance.id) ? [instance.id] : []
  )));
  if (removed.size === 0) return next.portfolios;
  const pulledIds = Array.isArray(pulledPortfolios) ? idsOf(pulledPortfolios) : new Set<string>();
  const portfolios = next.portfolios.filter((portfolio) => (
    !portfolio.brokerInstanceId || !removed.has(portfolio.brokerInstanceId) || pulledIds.has(portfolio.id)
  ));
  return portfolios.length === next.portfolios.length ? next.portfolios : portfolios;
}

interface RemovedBrokerHoldings {
  instanceIds: ReadonlySet<string>;
  portfolioIds: ReadonlySet<string>;
}

/** The profiles a pull removed, and the portfolios that went with them. */
function removedBrokerHoldings(before: AppConfig, after: AppConfig): RemovedBrokerHoldings | null {
  const remaining = new Set(after.brokerInstances.map((instance) => instance.id));
  const instanceIds = new Set(before.brokerInstances.flatMap((instance) => (
    remaining.has(instance.id) ? [] : [instance.id]
  )));
  if (instanceIds.size === 0) return null;
  const keptPortfolios = new Set(after.portfolios.map((portfolio) => portfolio.id));
  const portfolioIds = new Set(before.portfolios.flatMap((portfolio) => (
    portfolio.brokerInstanceId && instanceIds.has(portfolio.brokerInstanceId) && !keptPortfolios.has(portfolio.id)
      ? [portfolio.id]
      : []
  )));
  return { instanceIds, portfolioIds };
}

/**
 * The ticker as the removal on the other device left it: without the removed
 * profiles' positions and contracts, or its place in their portfolios. Null
 * when nothing is left to keep, as that removal deleted it; the same record
 * when the removal did not touch it.
 */
function withoutRemovedBrokerHoldings(ticker: TickerRecord, removed: RemovedBrokerHoldings): TickerRecord | null {
  const { metadata } = ticker;
  const positions = metadata.positions.filter((position) => (
    !(position.brokerInstanceId && removed.instanceIds.has(position.brokerInstanceId))
    && !removed.portfolioIds.has(position.portfolio)
  ));
  const portfolios = metadata.portfolios.filter((portfolioId) => !removed.portfolioIds.has(portfolioId));
  const contracts = (metadata.broker_contracts ?? []).filter((contract) => (
    !(contract.brokerInstanceId && removed.instanceIds.has(contract.brokerInstanceId))
  ));
  if (
    positions.length === metadata.positions.length
    && portfolios.length === metadata.portfolios.length
    && contracts.length === (metadata.broker_contracts ?? []).length
  ) {
    return ticker;
  }
  const empty = positions.length === 0
    && portfolios.length === 0
    && contracts.length === 0
    && metadata.watchlists.length === 0
    && metadata.tags.length === 0
    && Object.keys(metadata.custom).length === 0;
  if (empty) return null;
  return { ...ticker, metadata: { ...metadata, positions, portfolios, broker_contracts: contracts } };
}

function lastSyncedTickersById(baselinePayload: unknown): Map<string, Record<string, unknown>> | null {
  if (!isRecord(baselinePayload) || !Array.isArray(baselinePayload.tickers)) return null;
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of baselinePayload.tickers) {
    if (isRecord(entry) && typeof entry.ticker === "string") byId.set(entry.ticker, entry);
  }
  return byId;
}

/**
 * Compared as stored. What this device last synced is read back from storage
 * at launch without the fields that were undefined, so set against a copy
 * collected fresh as is, every ticker read as edited here: a device started
 * after a while away kept all its old rows and pushed them over newer ones.
 */
function sameAsStored(left: unknown, right: unknown): boolean {
  const stored = (value: unknown) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
  return stableStringify(stored(left)) === stableStringify(stored(right));
}

/**
 * A ticker's own fields. Quotes churn on every refresh, and which portfolios
 * hold it, and how much, merges portfolio by portfolio.
 */
function tickerOwnFields(metadata: Record<string, unknown>): Record<string, unknown> {
  const { quote: _quote, positions: _positions, portfolios: _portfolios, ...rest } = metadata;
  return rest;
}

/** One portfolio's part of a ticker: whether it lists the ticker, and the positions it holds in it. */
function holdingIn(positions: readonly TickerPosition[], links: readonly unknown[], portfolioId: string) {
  return {
    linked: links.includes(portfolioId),
    positions: positions.filter((position) => position.portfolio === portfolioId).map(sanitizePosition),
  };
}

/** Without a shared baseline, keep both devices' manual lots, matching identical copies one for one. */
function mergeUntrackedManualPositions(local: TickerPosition[], pulled: TickerPosition[]): TickerPosition[] {
  const unmatched = new Map<string, number>();
  for (const position of local) {
    const key = JSON.stringify(sanitizePosition(position));
    unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
  }
  const merged = [...local];
  for (const position of pulled) {
    const key = JSON.stringify(sanitizePosition(position));
    const count = unmatched.get(key) ?? 0;
    if (count > 0) unmatched.set(key, count - 1);
    else merged.push(position);
  }
  return merged;
}

interface PulledTickersMerge {
  lastSyncedTickers: Map<string, Record<string, unknown>> | null;
  /** This device's live broker portfolios, each with the side holding its latest broker sync. */
  brokerPortfolios: ReadonlyMap<string, "local" | "pulled">;
  known: KnownBrokerHoldings;
  /** Connections kept on this device: their portfolios' holdings here outlast any pull. */
  localOnly: LocalOnlyScope | null;
}

/**
 * Which side holds the latest sync of each live broker portfolio. Its
 * positions are what the broker last reported, so only a later sync replaces
 * them: a pushed copy older than this device's (from a device that was away,
 * or an older build) never takes away positions this device's broker reported
 * since, whatever other portfolios hold on the same ticker.
 */
function latestBrokerPortfolioSyncs(
  atPullStart: AppConfig,
  live: AppConfig,
  pulledPortfolios: unknown,
): Map<string, "local" | "pulled"> {
  const pulledSyncedAt = new Map<string, number>();
  for (const portfolio of Array.isArray(pulledPortfolios) ? pulledPortfolios : []) {
    if (isRecord(portfolio) && typeof portfolio.id === "string" && isFiniteNumber(portfolio.lastSyncedAt)) {
      pulledSyncedAt.set(portfolio.id, portfolio.lastSyncedAt);
    }
  }
  const sides = new Map<string, "local" | "pulled">();
  for (const portfolio of live.portfolios) {
    if (!getBrokerInstance(live.brokerInstances, portfolio.brokerInstanceId)) continue;
    const localSyncedAt = atPullStart.portfolios.find((entry) => entry.id === portfolio.id)?.lastSyncedAt;
    // Never synced here: its positions merge like a manual portfolio's.
    if (!isFiniteNumber(localSyncedAt)) continue;
    const pulled = pulledSyncedAt.get(portfolio.id);
    // Later than this device's copy, and than a sync here that ended while the pull was out.
    const pulledIsLater = pulled !== undefined
      && pulled > localSyncedAt
      && pulled >= (isFiniteNumber(portfolio.lastSyncedAt) ? portfolio.lastSyncedAt : 0);
    sides.set(portfolio.id, pulledIsLater ? "pulled" : "local");
  }
  return sides;
}

/**
 * A pulled ticker merged with this device's, portfolio by portfolio: this
 * device's part in a portfolio stays when it changed it since it last synced,
 * a live broker portfolio goes to the side with its latest sync, and the rest
 * comes from the pull. Broker contracts never sync and stay local.
 */
function mergePulledTicker(
  current: TickerRecord | undefined,
  pulled: Record<string, unknown>,
  merge: PulledTickersMerge,
): TickerRecord {
  const local = current?.metadata;
  const baseline = merge.lastSyncedTickers?.get(String(pulled.ticker));
  // Nothing to compare with (no copy here, or this device never synced): the pull is taken.
  const comparable = !!local && !!merge.lastSyncedTickers;
  // No copy last synced means this device never uploaded the ticker: filed
  // locally it is unsynced work, unfiled it is not something sync tracks.
  const ownFieldsEdited = comparable && (baseline
    ? !sameAsStored(tickerOwnFields(sanitizeTickerMetadata(local)), tickerOwnFields(baseline))
    : isSyncableTicker(sanitizeTickerMetadata(local)));

  const localPositions = local?.positions ?? [];
  const localLinks = local?.portfolios ?? [];
  const pulledPositions = Array.isArray(pulled.positions)
    ? mergeLocalBrokerPositionIdentity(localPositions, pulled.positions as TickerPosition[])
    : localPositions;
  const pulledLinks = Array.isArray(pulled.portfolios)
    ? pulled.portfolios.filter((portfolioId): portfolioId is string => typeof portfolioId === "string")
    : localLinks;
  const baselinePositions = Array.isArray(baseline?.positions) ? baseline.positions as TickerPosition[] : [];
  const baselineLinks = Array.isArray(baseline?.portfolios) ? baseline.portfolios : [];

  const portfolioIds = [...new Set([
    ...localLinks, ...localPositions.map((position) => position.portfolio),
    ...pulledLinks, ...pulledPositions.map((position) => position.portfolio),
  ])];
  const positions: TickerPosition[] = [];
  const portfolios: string[] = [];
  for (const portfolioId of portfolioIds) {
    const brokerSide = merge.brokerPortfolios.get(portfolioId);
    const takePulled = merge.localOnly?.portfolioIds.has(portfolioId) ? false : brokerSide
      ? brokerSide === "pulled"
      : !comparable || sameAsStored(
        holdingIn(localPositions, localLinks, portfolioId),
        holdingIn(baselinePositions, baselineLinks, portfolioId),
      );
    const [sidePositions, sideLinks] = takePulled ? [pulledPositions, pulledLinks] : [localPositions, localLinks];
    if (brokerSide && !merge.localOnly?.portfolioIds.has(portfolioId)) {
      // A broker's timestamp governs imported holdings, never hand-entered
      // lots. Those use the same edit comparison as a manual portfolio.
      const manualIn = (entries: readonly TickerPosition[]) => entries.filter((position) => (
        position.portfolio === portfolioId && position.broker === "manual"
      ));
      const localManual = manualIn(localPositions);
      const manualEdited = comparable && !sameAsStored(
        localManual.map(sanitizePosition), manualIn(baselinePositions).map(sanitizePosition),
      );
      const pulledManual = manualIn(pulledPositions);
      const manual = !comparable ? mergeUntrackedManualPositions(localManual, pulledManual)
        : manualEdited ? localManual : pulledManual;
      positions.push(...sidePositions.filter((position) => position.portfolio === portfolioId && position.broker !== "manual"), ...manual);
      if (sideLinks.includes(portfolioId) || manual.length > 0) portfolios.push(portfolioId);
    } else {
      positions.push(...sidePositions.filter((position) => position.portfolio === portfolioId));
      if (sideLinks.includes(portfolioId)) portfolios.push(portfolioId);
    }
  }

  const record: TickerRecord = {
    metadata: hydrateTickerMetadata({
      ...(ownFieldsEdited ? local : { ...local, ...pulled }),
      positions,
      portfolios,
      broker_contracts: local?.broker_contracts ?? [],
    }),
  };
  return clearLeftoverBrokerHoldings(record, merge.known) ?? record;
}

/**
 * A ticker the pull did not carry: without what removed broker profiles left,
 * and without positions in a broker portfolio whose later sync elsewhere no
 * longer reports the ticker. Null when nothing changes.
 */
function withoutUnpulledHoldings(ticker: TickerRecord, merge: PulledTickersMerge): TickerRecord | null {
  const sold = (portfolioId: string) => merge.brokerPortfolios.get(portfolioId) === "pulled";
  const { metadata } = ticker;
  const positions = metadata.positions.filter((position) => position.broker === "manual" || !sold(position.portfolio));
  const held = new Set(positions.map((position) => position.portfolio));
  const portfolios = metadata.portfolios.filter((portfolioId) => held.has(portfolioId) || !sold(portfolioId));
  const kept = positions.length === metadata.positions.length && portfolios.length === metadata.portfolios.length
    ? ticker
    : { ...ticker, metadata: { ...metadata, positions, portfolios } };
  const cleaned = clearLeftoverBrokerHoldings(kept, merge.known) ?? kept;
  return cleaned === ticker ? null : cleaned;
}

const CORE_CONFIG_CONTRIBUTOR_ID = "core.config";

export const coreConfigSyncContributor: SyncContributor = {
  id: CORE_CONFIG_CONTRIBUTOR_ID,
  schemaVersion: 1,
  collect: ({ state, baselinePayload, memo }) => withLayoutProvenance(
    collectCoreConfigPayload(publicConfig(state.config, localOnlyScope(state.config))) as Record<string, unknown>,
    baselinePayload,
    memo?.get(),
  ),
  observe: ({ state, baselinePayload, memo, launch }) => {
    const edit = noteLayoutEdit(state.config, baselinePayload, memo.get(), launch);
    if (edit) memo.set(edit);
  },
  apply: async (payload, { snapshot, baselinePayload, baselineState, state, getState, isCurrent, dispatch, tickerRepository, memo }) => {
    const pushedAt = snapshot?.contributors[CORE_CONFIG_CONTRIBUTOR_ID]?.updatedAt;
    const merge = (config: AppConfig) => mergeConfigPayload(config, payload, baselineState.config, baselinePayload, {
      memo: memo?.get(),
      pushedAt,
    }, localOnlyScope(config));
    let nextConfig = merge(state.config);
    if (!nextConfig) return;
    const removed = removedBrokerHoldings(state.config, nextConfig);
    if (removed) {
      // Keep the profile until row and config writes succeed, so a failed
      // cleanup remains visible to the next attempt.
      const cleanTickers = () => persistTickerCleanup({
        tickerRepository,
        getTickers: () => getState().tickers,
        transform: (ticker) => withoutRemovedBrokerHoldings(ticker, removed),
        publish: (symbol, ticker) => {
          const tickers = new Map(getState().tickers);
          if (ticker) tickers.set(symbol, ticker);
          else tickers.delete(symbol);
          dispatch({ type: "SET_TICKERS", tickers });
        },
        isCurrent,
      });
      let savedRemoval = false;
      for (;;) {
        const cleaned = await cleanTickers().catch(async (error: unknown) => {
          // Restore the profile if a late row fails after config was saved,
          // so retry can also recover after restarting the app.
          if (savedRemoval) await saveConfigImmediately(getState().config);
          throw error;
        });
        if (!cleaned || !isCurrent()) return;
        if (hasPendingTickerWrites(tickerRepository) || getState().tickers !== cleaned) continue;
        const source = getState().config;
        const merged = merge(source);
        if (!merged) return;
        // Preserve unrelated edits while retaining the removal already applied
        // to rows, including pulls from builds that merged whole profile lists.
        nextConfig = {
          ...merged,
          brokerInstances: merged.brokerInstances.filter((instance) => !removed.instanceIds.has(instance.id)),
          portfolios: merged.portfolios.filter((portfolio) => !removed.portfolioIds.has(portfolio.id)),
        };
        await saveConfigImmediately(nextConfig);
        savedRemoval = true;
        if (!isCurrent()) return;
        if (getState().config !== source || getState().tickers !== cleaned
          || hasPendingTickerWrites(tickerRepository)) continue;
        break;
      }
    }
    const configChanged = !valuesEqual(nextConfig, getState().config);
    if (configChanged) {
      // Adopting another device's workspace rearranges the screen under the
      // user, so it is worth a line in the log when a report says "my panes
      // moved on their own".
      if (nextConfig.layout !== state.config.layout) {
        log.info("config.layout.adopted", {
          panes: nextConfig.layout.instances.length,
          activeLayoutIndex: nextConfig.activeLayoutIndex,
        });
      }
      // An Attention Counts off from another device drops unsent counts before React commits.
      if (nextConfig.telemetry !== getState().config.telemetry) reportTelemetryConfig(nextConfig.telemetry);
      dispatch({ type: "SET_CONFIG", config: nextConfig });
      if (!removed) scheduleConfigSave(nextConfig);
    }
    if (memo && isRecord(payload)) rememberCloudLayout(payload, pushedAt, getState().config, memo, nextConfig.layouts !== state.config.layouts);
  },
};

export const coreCollectionsSyncContributor: SyncContributor = {
  id: "core.collections",
  schemaVersion: 1,
  collect: async ({ state, isLocalMarketData }) => {
    // Connections the user keeps on this device stay here, with their portfolios, account values and
    // positions; so do the quotes and bars of a source that keeps its market data local.
    const scope = localOnlyScope(state.config);
    const config = publicConfig(state.config, scope);
    const tickers = publicTickers(state.tickers, scope);
    return collectCoreCollectionsPayload(
      config,
      tickers,
      state.financials,
      await loadHoldingExchangeRates(config, tickers, state.financials),
      state.brokerAccounts,
      publicMarketData(state.financials, isLocalMarketData),
    );
  },
  apply: async (payload, { snapshot, baselinePayload, baselineState, getState, isCurrent, dispatch, tickerRepository }) => {
    if (!isRecord(payload)) return;
    const scope = localOnlyScope(getState().config);
    hydrateProfileAnalytics(payload);
    if (!isCurrent()) return;
    // The config contributor applies first, so this is the config this pull left.
    const state = getState();
    const pulledConfig = recordOrNull(snapshot?.contributors[CORE_CONFIG_CONTRIBUTOR_ID]?.payload);
    const pulledPortfolios = Array.isArray(payload.portfolios) ? payload.portfolios : pulledConfig?.portfolios;
    // A copy without its ticker list says nothing of what any portfolio holds:
    // a later sync stamp there must not take this device's broker positions.
    const pulledTickers = Array.isArray(payload.tickers) ? payload.tickers : null;
    const merge: PulledTickersMerge = {
      lastSyncedTickers: lastSyncedTickersById(baselinePayload),
      brokerPortfolios: pulledTickers
        ? latestBrokerPortfolioSyncs(baselineState.config, state.config, pulledPortfolios)
        : new Map(),
      // A broker portfolio the pull still lists may only exist on another device: it stays.
      known: knownBrokerHoldings(state.config, {
        portfolios: [pulledPortfolios, pulledConfig?.portfolios].flatMap(idEntries),
        brokerInstances: idEntries(pulledConfig?.brokerInstances),
      }),
      localOnly: scope,
    };
    // Tickers here and pulled ones drop the ids of any watchlist that is gone
    // (removed elsewhere, or deleted by an older build that left its id on the
    // tickers), so this device never pushes them back.
    const watchlistIds = new Set(state.config.watchlists.map((watchlist) => watchlist.id));

    // Merged and handed to the app in one go, with no wait in between, so a
    // broker sync committing meanwhile is not overwritten with an older row.
    const nextTickers = new Map(state.tickers);
    const changed: TickerRecord[] = [];
    const pulledSymbols = new Set<string>();
    for (const rawTicker of pulledTickers ?? []) {
      if (!isRecord(rawTicker) || typeof rawTicker.ticker !== "string") continue;
      pulledSymbols.add(rawTicker.ticker);
      const current = state.tickers.get(rawTicker.ticker);
      const record = withoutMissingWatchlists(mergePulledTicker(current, rawTicker, merge), watchlistIds);
      if (current ? sameAsStored(record.metadata, hydrateTickerMetadata({ ...current.metadata })) : !isSyncableTicker(record.metadata)) continue;
      nextTickers.set(record.metadata.ticker, record);
      changed.push(record);
    }
    for (const ticker of state.tickers.values()) {
      if (pulledSymbols.has(ticker.metadata.ticker)) continue;
      const kept = withoutUnpulledHoldings(ticker, merge) ?? ticker;
      const next = withoutMissingWatchlists(kept, watchlistIds);
      if (next === ticker) continue;
      nextTickers.set(next.metadata.ticker, next);
      changed.push(next);
    }
    const suffixed = mergePulledSuffixedListings(nextTickers, changed, state.config);
    if (changed.length === 0 && !suffixed.config) return;
    if (suffixed.config) dispatch({ type: "SET_CONFIG", config: suffixed.config });
    if (changed.length > 0) dispatch({ type: "SET_TICKERS", tickers: nextTickers });
    // The moved targets first, so a stop before the rows strands none on an emptied key.
    if (suffixed.config) await saveConfigImmediately(suffixed.config);
    // Written one at a time, so an edit or a broker sync can replace a row
    // before its turn. That copy is newer and its writer saves it; this one
    // written over it would come back at launch as an edit and be pushed.
    for (const record of changed) {
      if (getState().tickers.get(record.metadata.ticker) !== record) continue;
      await tickerRepository.saveTicker(record);
    }
  },
};

/**
 * An older build still files lots under a vendor's suffixed key (GARAN.IS)
 * and pushes them: pulled, they merge into the listing's row here as at
 * launch (`mergeSuffixedListings`), each lot once, so they never count in
 * both rows or go back out under the old key. The merged rows replace their
 * entries in `tickers` and `changed`; the config comes back with targets
 * moved, or null when none moved.
 */
function mergePulledSuffixedListings(
  tickers: Map<string, TickerRecord>,
  changed: TickerRecord[],
  config: AppConfig,
): { config: AppConfig | null } {
  const merged = mergeSuffixedListings([...tickers.values()]);
  if (!merged) return { config: null };
  for (const row of merged.saves) {
    tickers.set(row.metadata.ticker, row);
    const at = changed.findIndex((record) => record.metadata.ticker === row.metadata.ticker);
    if (at >= 0) changed[at] = row;
    else changed.push(row);
  }
  for (const kept of merged.keptCustom) log.info("sync.suffixed-listing.custom-kept", kept);
  const next = moveTargetWeights(config, merged.moved);
  return { config: next === config ? null : next };
}

export function createCoreSyncContributors(): SyncContributor[] {
  return [coreConfigSyncContributor, coreCollectionsSyncContributor];
}

export const __syncContributorInternalsForTests = {
  layoutIntent,
  sanitizeUnknown,
  collectCoreConfigPayload,
  collectCoreCollectionsPayload,
  mergeConfigPayload,
};
