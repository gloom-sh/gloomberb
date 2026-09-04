import { scheduleConfigSave } from "../state/config-save-scheduler";
import { stableStringify } from "../remote/revision";
import type { AppConfig, BrokerInstanceConfig } from "../types/config";
import type { PricePoint, TickerFinancials } from "../types/financials";
import type { Portfolio, TickerMetadata, TickerPosition, TickerRecord, Watchlist } from "../types/ticker";
import type { BrokerAccount } from "../types/trading";
import { hydrateTickerMetadata } from "../tickers/metadata";
import type { SyncContributor } from "./types";
import { convertCurrency } from "../utils/format";
import {
  computeDatedBeta,
  computeDatedReturns,
  computeWeightedPortfolioReturns,
  type WeightedReturnSeries,
} from "../plugins/builtin/analytics/metrics";
import {
  getSyncedProfileAnalytics,
  setSyncedProfileAnalytics,
} from "./profile-analytics";
import {
  addLegacyBuiltinDisabledPluginAliases,
  addLegacyBuiltinPaneStatePluginAliases,
  addLegacyBuiltinPluginOwnerAliases,
  normalizeBuiltinDisabledPluginIds,
  normalizeBuiltinPaneStatePluginOwners,
  normalizeBuiltinPluginStateMap,
} from "../plugins/ownership";

const SENSITIVE_KEY_PATTERN = /(token|secret|password|credential|private|api[_-]?key|access[_-]?key|refresh[_-]?key|session|cookie|dataDir|path|directory|localPath)/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function sanitizeUnknown(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeUnknown).filter((entry) => entry !== undefined);
  }
  if (!isPlainObject(value)) return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) continue;
    const sanitized = sanitizeUnknown(child);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

function sanitizePortfolio(portfolio: Portfolio): Portfolio {
  return {
    id: portfolio.id,
    name: portfolio.name,
    description: portfolio.description,
    currency: portfolio.currency,
    brokerId: portfolio.brokerId,
    lastSyncedAt: portfolio.lastSyncedAt,
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

function weeklyQuoteMove(financials: TickerFinancials | null | undefined) {
  const quote = financials?.quote;
  if (!quote || !Number.isFinite(quote.price) || quote.price <= 0) return undefined;
  const history = (financials?.priceHistory ?? [])
    .filter((point) => Number.isFinite(point.close) && point.close > 0 && Number.isFinite(pricePointTime(point)))
    .sort((left, right) => pricePointTime(left) - pricePointTime(right));
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
    quote: sanitizeQuote(financials),
  };
}

function collectCoreConfigPayload(config: AppConfig) {
  return sanitizeUnknown({
    configVersion: config.configVersion,
    baseCurrency: config.baseCurrency,
    refreshIntervalMinutes: config.refreshIntervalMinutes,
    portfolios: config.portfolios.map(sanitizePortfolio),
    watchlists: config.watchlists.map(sanitizeWatchlist),
    layout: config.layout,
    layouts: config.layouts.map((savedLayout) => (
      savedLayout.paneState
        ? {
          ...savedLayout,
          paneState: addLegacyBuiltinPaneStatePluginAliases(savedLayout.paneState),
        }
        : savedLayout
    )),
    activeLayoutIndex: config.activeLayoutIndex,
    brokerInstances: config.brokerInstances.map(sanitizeBrokerInstance),
    disabledPlugins: addLegacyBuiltinDisabledPluginAliases(config.disabledPlugins),
    disabledSources: config.disabledSources,
    pluginConfig: addLegacyBuiltinPluginOwnerAliases(config.pluginConfig),
    theme: config.theme,
    chartPreferences: config.chartPreferences,
    valueFlashingEnabled: config.valueFlashingEnabled,
    recentTickers: config.recentTickers,
    // Completion is monotonic in synced state. A device only advertises the
    // completed state, while resumable progress and incomplete state stay local.
    onboardingComplete: config.onboardingComplete === true ? true : undefined,
  });
}

function positionValueBase(
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
  if (!Number.isFinite(position.shares) || typeof price !== "number" || !Number.isFinite(price)) return null;
  return convertCurrency(
    Math.abs(position.shares * price * (position.multiplier ?? 1)),
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

function oneYearReturnFromSeries(series: WeightedReturnSeries[]): number | null {
  const returns = computeWeightedPortfolioReturns(series);
  if (returns.length === 0) return null;
  const cumulative = returns.reduce((acc, point) => (
    Number.isFinite(point.value) ? acc * (1 + point.value) : acc
  ), 1) - 1;
  return Number.isFinite(cumulative) ? cumulative : null;
}

function collectAnalyticsByPortfolio(
  config: AppConfig,
  tickers: Map<string, TickerRecord>,
  financials: Map<string, TickerFinancials>,
  exchangeRates: Map<string, number>,
) {
  const output: Record<string, Record<string, unknown>> = {};
  const spyReturns = computeDatedReturns(recentPriceHistory(financials.get("SPY")?.priceHistory ?? [], 366));
  for (const portfolio of config.portfolios) {
    let returnWeight = 0;
    let weightedReturn = 0;
    const datedReturnSeries: WeightedReturnSeries[] = [];
    for (const ticker of tickers.values()) {
      const tickerFinancials = financials.get(ticker.metadata.ticker);
      const portfolioPositions = ticker.metadata.positions.filter((position) => position.portfolio === portfolio.id);
      if (portfolioPositions.length === 0 && !ticker.metadata.portfolios.includes(portfolio.id)) continue;
      for (const position of portfolioPositions) {
        const value = positionValueBase(position, tickerFinancials, config.baseCurrency, exchangeRates);
        if (value != null) {
          const return1Y = tickerFinancials?.fundamentals?.return1Y;
          if (typeof return1Y === "number" && Number.isFinite(return1Y)) {
            returnWeight += value;
            weightedReturn += return1Y * value;
          }
          const returns = computeDatedReturns(recentPriceHistory(tickerFinancials?.priceHistory ?? [], 366));
          if (returns.length >= 10) datedReturnSeries.push({ weight: value, returns });
        }
      }
    }
    const portfolioReturns = computeWeightedPortfolioReturns(datedReturnSeries);
    const previewAnalytics = getSyncedProfileAnalytics(portfolio.id);
    output[portfolio.id] = {
      oneYearReturn: previewAnalytics?.oneYearReturn
        ?? (returnWeight > 0 ? weightedReturn / returnWeight : oneYearReturnFromSeries(datedReturnSeries)),
      spyBeta: previewAnalytics?.spyBeta
        ?? (
          portfolioReturns.length > 0 && spyReturns.length > 0
            ? computeDatedBeta(portfolioReturns, spyReturns)
            : null
        ),
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

function collectCoreCollectionsPayload(
  config: AppConfig,
  tickers: Map<string, TickerRecord>,
  financials: Map<string, TickerFinancials>,
  exchangeRates: Map<string, number>,
  brokerAccounts: Record<string, BrokerAccount[]>,
) {
  const records = [...tickers.values()]
    .map((ticker) => sanitizeTickerMetadata(ticker.metadata, financials.get(ticker.metadata.ticker)))
    .filter(isSyncableTicker);

  return {
    baseCurrency: config.baseCurrency,
    exchangeRates: Object.fromEntries(
      [...exchangeRates.entries()]
        .filter(([currency, rate]) => (
          typeof currency === "string" &&
          Number.isFinite(rate) &&
          rate > 0
        ))
        .map(([currency, rate]) => [currency.trim().toUpperCase(), rate]),
    ),
    portfolios: config.portfolios.map(sanitizePortfolio),
    watchlists: config.watchlists.map(sanitizeWatchlist),
    analyticsByPortfolio: collectAnalyticsByPortfolio(config, tickers, financials, exchangeRates),
    accountsByPortfolio: collectAccountsByPortfolio(config, brokerAccounts),
    tickers: records,
  };
}

function hydrateProfileAnalytics(payload: Record<string, unknown>): void {
  if (!isPlainObject(payload.analyticsByPortfolio)) return;
  for (const [portfolioId, analytics] of Object.entries(payload.analyticsByPortfolio)) {
    if (!isPlainObject(analytics)) continue;
    setSyncedProfileAnalytics(portfolioId, {
      oneYearReturn: typeof analytics.oneYearReturn === "number" ? analytics.oneYearReturn : null,
      spyBeta: typeof analytics.spyBeta === "number" ? analytics.spyBeta : null,
    });
  }
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function isPluginStateMap(value: unknown): value is Record<string, Record<string, unknown>> {
  return isPlainObject(value) && Object.values(value).every(isPlainObject);
}

function normalizeSyncedLayouts(layouts: AppConfig["layouts"]): AppConfig["layouts"] {
  return layouts.map((savedLayout) => {
    if (!isPlainObject(savedLayout)) return savedLayout;
    if (!isPluginStateMap(savedLayout.paneState)) return savedLayout;
    return {
      ...savedLayout,
      paneState: normalizeBuiltinPaneStatePluginOwners(savedLayout.paneState),
    };
  });
}

function mergeConfigPayload(
  config: AppConfig,
  payload: unknown,
  baselineConfig: AppConfig = config,
  lastSyncedPayload?: unknown,
): AppConfig | null {
  if (!isPlainObject(payload)) return null;
  const next: AppConfig = { ...config };
  // Two guards, both needed. baselineConfig catches edits made while this pull
  // was in flight; lastSyncedPayload catches edits made while the app was not
  // running at all (CLI writes, offline edits), which otherwise look pristine.
  const lastSynced = isPlainObject(lastSyncedPayload) ? lastSyncedPayload : null;
  const localPayload = lastSynced
    ? collectCoreConfigPayload(config) as Record<string, unknown>
    : null;
  const matchesLastSynced = (key: string) => (
    !lastSynced || valuesEqual(localPayload?.[key], lastSynced[key])
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
    next.disabledPlugins = normalizeBuiltinDisabledPluginIds(payload.disabledPlugins);
  }
  if (canApply("pluginConfig") && isPluginStateMap(payload.pluginConfig)) {
    next.pluginConfig = normalizeBuiltinPluginStateMap(payload.pluginConfig);
  }

  const layoutStateUntouched = config.layout === baselineConfig.layout
    && config.layouts === baselineConfig.layouts
    && config.activeLayoutIndex === baselineConfig.activeLayoutIndex
    && ["layout", "layouts", "activeLayoutIndex"].every(matchesLastSynced);
  if (
    layoutStateUntouched
    && ["layout", "layouts", "activeLayoutIndex"].every((key) => key in payload)
    && Array.isArray(payload.layouts)
  ) {
    next.layout = payload.layout as unknown as AppConfig["layout"];
    next.layouts = normalizeSyncedLayouts(payload.layouts as AppConfig["layouts"]);
    next.activeLayoutIndex = payload.activeLayoutIndex as number;
  }

  if (Array.isArray(payload.brokerInstances) && canApply("brokerInstances")) {
    const incoming = payload.brokerInstances as Array<Partial<BrokerInstanceConfig>>;
    const existingById = new Map(config.brokerInstances.map((instance) => [instance.id, instance]));
    next.brokerInstances = incoming.map((instance) => {
      const current = instance.id ? existingById.get(instance.id) : undefined;
      return {
        id: instance.id ?? current?.id ?? crypto.randomUUID(),
        brokerType: instance.brokerType ?? current?.brokerType ?? "",
        label: instance.label ?? current?.label ?? "",
        connectionMode: instance.connectionMode ?? current?.connectionMode,
        enabled: instance.enabled ?? current?.enabled,
        lastSyncedAt: instance.lastSyncedAt ?? current?.lastSyncedAt,
        config: current?.config ?? {},
      };
    });
  }
  return next;
}

function lastSyncedTickersById(baselinePayload: unknown): Map<string, Record<string, unknown>> | null {
  if (!isPlainObject(baselinePayload) || !Array.isArray(baselinePayload.tickers)) return null;
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of baselinePayload.tickers) {
    if (isPlainObject(entry) && typeof entry.ticker === "string") byId.set(entry.ticker, entry);
  }
  return byId;
}

/** Quotes churn on every refresh, so they cannot signal a user edit. */
function withoutQuote(metadata: Record<string, unknown>): Record<string, unknown> {
  const { quote: _quote, ...rest } = metadata;
  return rest;
}

function tickerChangedSinceLastSync(
  current: TickerRecord | null | undefined,
  lastSyncedTickers: Map<string, Record<string, unknown>> | null,
): boolean {
  if (!lastSyncedTickers || !current) return false;
  const local = sanitizeTickerMetadata(current.metadata);
  const baseline = lastSyncedTickers.get(current.metadata.ticker);
  // No baseline entry means this device never uploaded the ticker: filed
  // locally it is unsynced work, unfiled it is not something sync tracks.
  if (!baseline) return isSyncableTicker(local);
  return !valuesEqual(withoutQuote(local), withoutQuote(baseline));
}

export const coreConfigSyncContributor: SyncContributor = {
  id: "core.config",
  schemaVersion: 1,
  collect: ({ state }) => collectCoreConfigPayload(state.config),
  apply: (payload, { baselinePayload, baselineState, state, dispatch }) => {
    const nextConfig = mergeConfigPayload(state.config, payload, baselineState.config, baselinePayload);
    if (!nextConfig || valuesEqual(nextConfig, state.config)) return;
    dispatch({ type: "SET_CONFIG", config: nextConfig });
    scheduleConfigSave(nextConfig);
  },
};

export const coreCollectionsSyncContributor: SyncContributor = {
  id: "core.collections",
  schemaVersion: 1,
  collect: ({ state }) => collectCoreCollectionsPayload(
    state.config,
    state.tickers,
    state.financials,
    state.exchangeRates,
    state.brokerAccounts,
  ),
  apply: async (payload, { baselinePayload, getState, isCurrent, dispatch, tickerRepository }) => {
    if (!isPlainObject(payload)) return;
    hydrateProfileAnalytics(payload);
    const lastSyncedTickers = lastSyncedTickersById(baselinePayload);
    const incomingRecords: TickerRecord[] = [];
    const rawTickers = Array.isArray(payload.tickers) ? payload.tickers : [];
    for (const rawTicker of rawTickers) {
      if (!isCurrent()) return;
      if (!isPlainObject(rawTicker)) continue;
      const current = typeof rawTicker.ticker === "string"
        ? getState().tickers.get(rawTicker.ticker)
        : null;
      // Local edits the cloud has never seen (CLI positions, offline changes)
      // win here and are uploaded by the push that follows this pull.
      if (tickerChangedSinceLastSync(current, lastSyncedTickers)) continue;
      const syncedPositions = Array.isArray(rawTicker.positions)
        ? mergeLocalBrokerPositionIdentity(
          current?.metadata.positions ?? [],
          rawTicker.positions as TickerPosition[],
        )
        : current?.metadata.positions ?? [];
      const metadata = hydrateTickerMetadata({
        ...current?.metadata,
        ...rawTicker,
        positions: syncedPositions,
        broker_contracts: current?.metadata.broker_contracts ?? [],
      });
      const record: TickerRecord = { metadata };
      await tickerRepository.saveTicker(record);
      incomingRecords.push(record);
    }

    if (!isCurrent() || incomingRecords.length === 0) return;
    const nextTickers = new Map(getState().tickers);
    for (const record of incomingRecords) {
      nextTickers.set(record.metadata.ticker, record);
    }
    dispatch({ type: "SET_TICKERS", tickers: nextTickers });
  },
};

export function createCoreSyncContributors(): SyncContributor[] {
  return [coreConfigSyncContributor, coreCollectionsSyncContributor];
}

export const __syncContributorInternalsForTests = {
  sanitizeUnknown,
  collectCoreConfigPayload,
  collectCoreCollectionsPayload,
  mergeConfigPayload,
};
