import type { BrokerCandidate } from "./brokers";
import { withBrokerTimeout } from "./brokers";
import type { DataProvider, MarketDataRequestContext } from "../../types/data-provider";
import type { PricePoint } from "../../types/financials";
import type { TimeRange } from "../../time-series/range";
import {
  isIntradayResolution,
  normalizeChartResolutionSupport,
  TIME_RANGE_ORDER,
  type ChartResolutionSupport,
  type ManualChartResolution,
} from "../../time-series/resolution";
import { subtractTimeRange } from "../../time-series/date-window";
import { clipPriceHistoryToRange } from "../../time-series/history-window";
import { repairIsolatedIntradayOhlcOutliers } from "../../time-series/history-quality";
import { canonicalExchange, parsePublicTickerKey } from "../../utils/exchanges";
import { resolvePriceHistoryCurrencyUnit } from "../../utils/currency-units";
import { isPriceHistoryStaleForCurrentWindow, normalizePriceHistory, priceHistoryIntervalMs } from "../../utils/price-history";
import { shouldLogProviderError } from "../provider-errors";
import { hasUnverifiedShellHistory, HistoryCoverageError } from "../history-coverage";
import {
  buildVariantKey,
  compactDate,
  isCurrentHistoryWindow,
  isIntradayRange,
  isStaleIntradayHistory,
  listCachedResources,
  type ProviderRouterCachePolicyKey,
} from "./cache";
import type { ProviderRouterCoreDeps, SourceResult } from "./route-types";
import { makeRouterRequestIdentity, scheduleRouterRevalidation, type RouterRequestIdentity } from "./routing";

type PriceHistoryCachePolicyKey = Extract<
  ProviderRouterCachePolicyKey,
  "priceHistoryIntraday" | "priceHistoryDaily"
>;
const PRICE_HISTORY_CACHE_VERSION = 4;

interface HistoryRequestDescriptor {
  target: { symbol: string; exchange: string };
  identity: RouterRequestIdentity;
  cacheVariantKeys: string[];
  exactCacheVariantKeys: string[];
  requestedRange?: TimeRange;
  requestedStart: number;
  context?: MarketDataRequestContext;
  cachePolicyKey: PriceHistoryCachePolicyKey;
  missingProviderError?: string;
  isCachedValueStale(value: PricePoint[]): boolean;
  isFetchedValueStale(value: PricePoint[]): boolean;
  fetchBroker(candidate: BrokerCandidate): Promise<PricePoint[] | null>;
  fetchProvider(provider: DataProvider): Promise<PricePoint[] | null>;
}

function priceHistoryVariantParts(
  parts: Array<[string, string | number | undefined | null]>,
  exchange: string,
  ticker: string,
): Array<[string, string | number | undefined | null]> {
  const unit = resolvePriceHistoryCurrencyUnit(null, exchange);
  const target = parsePublicTickerKey(ticker);
  const venue = target.exchange || canonicalExchange(exchange);
  // Old cloud weekly/monthly JEPQ responses contained prices from 2013, before
  // this fund existed. Refetch this exact US/bare identity after backend repair;
  // neither broader cached windows nor saved detailed requests may reuse them.
  const bar = parts.find(([key]) => key === "resolution" || key === "bar")?.[1];
  const range = parts.find(([key]) => key === "range")?.[1];
  const intraday = typeof bar === "string" ? /^\d+(m|min|h)$/.test(bar)
    : typeof range === "string" && isIntradayRange(range as TimeRange);
  const inceptionVersion = !intraday && target.symbol === "JEPQ" && (!venue || venue === "NASDAQ") ? 1 : undefined;
  const monthly = bar === "1mo" || bar === "1month"
    || (bar == null && parts.some(([key, value]) => key === "range" && value === "ALL"));
  const versionedParts: Array<[string, string | number | undefined | null]> = [
    ...parts,
    ["version", PRICE_HISTORY_CACHE_VERSION],
    ["inception", inceptionVersion],
    ["calendar", monthly ? 1 : undefined],
  ];
  return unit.divisor === 1
    ? versionedParts
    : [...versionedParts, ["unit", unit.currency]];
}

function makeHistoryRequestIdentity(
  deps: Pick<ProviderRouterCoreDeps, "getEntityKey">,
  input: {
    kind: string;
    ticker: string;
    exchange: string;
    context?: MarketDataRequestContext;
    variantParts: Array<[string, string | number | undefined | null]>;
    fallbackVariantParts: Array<[string, string | number | undefined | null]>;
  },
): Pick<HistoryRequestDescriptor, "identity" | "cacheVariantKeys" | "exactCacheVariantKeys" | "target"> {
  const identity = makeRouterRequestIdentity(deps, {
    kind: input.kind,
    ticker: input.ticker,
    context: input.context,
    variantParts: priceHistoryVariantParts(input.variantParts, input.exchange, input.ticker),
  });
  const cacheVariantKeys = [
    identity.variantKey,
    buildVariantKey(priceHistoryVariantParts(input.fallbackVariantParts, input.exchange, input.ticker)),
  ];
  return {
    target: { symbol: input.ticker, exchange: input.exchange },
    identity,
    cacheVariantKeys,
    exactCacheVariantKeys: cacheVariantKeys,
  };
}

function expandedHistoryCacheVariantKeys(
  deps: Pick<ProviderRouterCoreDeps, "getEntityKey">,
  input: {
    ticker: string;
    exchange: string;
    context?: MarketDataRequestContext;
    range: TimeRange;
    resolution?: ManualChartResolution;
  },
): string[] {
  const start = TIME_RANGE_ORDER.indexOf(input.range);
  const ranges = start >= 0 ? TIME_RANGE_ORDER.slice(start) : [input.range];
  const keys: string[] = [];
  for (const range of ranges) {
    const { cacheVariantKeys } = makeHistoryRequestIdentity(deps, {
      kind: "price-history",
      ticker: input.ticker,
      exchange: input.exchange,
      context: input.context,
      variantParts: input.resolution
        ? [["exchange", canonicalExchange(input.exchange)], ["range", range], ["resolution", input.resolution]]
        : [["exchange", canonicalExchange(input.exchange)], ["range", range]],
      fallbackVariantParts: input.resolution
        ? [["range", range], ["resolution", input.resolution]]
        : [["range", range]],
    });
    keys.push(...cacheVariantKeys);
  }
  return [...new Set(keys)];
}

function normalizeRequestHistory(
  points: PricePoint[],
  request: Pick<HistoryRequestDescriptor, "cachePolicyKey">,
): PricePoint[] {
  const normalized = normalizePriceHistory(points);
  return request.cachePolicyKey === "priceHistoryIntraday"
    ? repairIsolatedIntradayOhlcOutliers(normalized)
    : normalized;
}

export class ProviderRouterHistoryRoutes {
  constructor(private readonly deps: ProviderRouterCoreDeps) {}
  private readonly historyRefreshInFlight = new Map<string, Promise<unknown>>();

  async getPriceHistory(
    ticker: string,
    exchange: string,
    range: TimeRange,
    context?: MarketDataRequestContext,
  ): Promise<PricePoint[]> {
    const identity = makeHistoryRequestIdentity(this.deps, {
      kind: "price-history",
      ticker,
      exchange,
      context,
      variantParts: [["exchange", canonicalExchange(exchange)], ["range", range]],
      fallbackVariantParts: [["range", range]],
    });
    const intraday = isIntradayRange(range);
    return this.executeHistoryRequest({
      ...identity,
      cacheVariantKeys: expandedHistoryCacheVariantKeys(this.deps, { ticker, exchange, context, range }),
      requestedRange: range,
      requestedStart: subtractTimeRange(new Date(), range).getTime(),
      context,
      cachePolicyKey: intraday ? "priceHistoryIntraday" : "priceHistoryDaily",
      missingProviderError: `No history provider available for ${ticker}`,
      isCachedValueStale: (value) => isStaleIntradayHistory(value, intraday, exchange),
      isFetchedValueStale: (value) => isStaleIntradayHistory(value, intraday, exchange),
      fetchBroker: async (candidate) => candidate.broker.getPriceHistory
        ? candidate.broker.getPriceHistory(
          ticker,
          candidate.instance,
          exchange,
          range,
          context?.instrument ?? null,
        )
        : null,
      fetchProvider: (provider) => provider.getPriceHistory(ticker, exchange, range, context),
    });
  }

  async getPriceHistoryForResolution(
    ticker: string,
    exchange: string,
    bufferRange: TimeRange,
    resolution: ManualChartResolution,
    context?: MarketDataRequestContext,
  ): Promise<PricePoint[]> {
    const identity = makeHistoryRequestIdentity(this.deps, {
      kind: "price-history",
      ticker,
      exchange,
      context,
      variantParts: [
        ["exchange", canonicalExchange(exchange)],
        ["range", bufferRange],
        ["resolution", resolution],
      ],
      fallbackVariantParts: [["range", bufferRange], ["resolution", resolution]],
    });
    const intraday = isIntradayResolution(resolution);
    const intervalMs = priceHistoryIntervalMs(resolution);
    return this.executeHistoryRequest({
      ...identity,
      cacheVariantKeys: expandedHistoryCacheVariantKeys(this.deps, {
        ticker,
        exchange,
        context,
        range: bufferRange,
        resolution,
      }),
      requestedRange: bufferRange,
      requestedStart: subtractTimeRange(new Date(), bufferRange).getTime(),
      context,
      cachePolicyKey: intraday ? "priceHistoryIntraday" : "priceHistoryDaily",
      missingProviderError: `No resolution-aware history provider available for ${ticker}`,
      isCachedValueStale: (value) => isStaleIntradayHistory(value, intraday, exchange, intervalMs),
      isFetchedValueStale: (value) => isStaleIntradayHistory(value, intraday, exchange, intervalMs),
      fetchBroker: async (candidate) => candidate.broker.getPriceHistoryForResolution
        ? candidate.broker.getPriceHistoryForResolution(
          ticker,
          candidate.instance,
          exchange,
          bufferRange,
          resolution,
          context?.instrument ?? null,
        )
        : null,
      fetchProvider: async (provider) => provider.getPriceHistoryForResolution
        ? provider.getPriceHistoryForResolution(ticker, exchange, bufferRange, resolution, context)
        : null,
    });
  }

  async getChartResolutionSupport(
    ticker: string,
    exchange?: string,
    context?: MarketDataRequestContext,
  ): Promise<ChartResolutionSupport[]> {
    const candidates = this.deps.getBrokerCandidatesForContext(context, false);
    const brokerSupport = await withBrokerTimeout(this.firstBrokerResult(candidates, async (candidate) => {
      const result = candidate.broker.getChartResolutionSupport
        ? normalizeChartResolutionSupport(await candidate.broker.getChartResolutionSupport(
          ticker,
          candidate.instance,
          exchange,
          context?.instrument ?? null,
        ))
        : candidate.broker.getChartResolutionCapabilities
          ? normalizeChartResolutionSupport(
            (await candidate.broker.getChartResolutionCapabilities(
              ticker,
              candidate.instance,
              exchange,
              context?.instrument ?? null,
            )).map((resolution) => ({ resolution, maxRange: "ALL" })),
          )
          : null;
      return result && result.length > 0 ? result : null;
    }));
    if (brokerSupport) return brokerSupport.value;

    const providerSupport = await this.firstProviderArrayResult(async (provider) => {
      if (provider.canProvide && !await provider.canProvide(ticker, exchange, context)) {
        return null;
      }
      if (provider.getChartResolutionSupport) {
        return normalizeChartResolutionSupport(await provider.getChartResolutionSupport(ticker, exchange, context));
      }
      if (provider.getChartResolutionCapabilities) {
        return normalizeChartResolutionSupport(
          (await provider.getChartResolutionCapabilities(ticker, exchange, context))
            .map((resolution) => ({ resolution, maxRange: "ALL" })),
        );
      }
      return null;
    });
    return providerSupport?.value ?? [];
  }

  async getChartResolutionCapabilities(
    ticker: string,
    exchange?: string,
    context?: MarketDataRequestContext,
  ): Promise<ManualChartResolution[]> {
    const support = await this.getChartResolutionSupport(ticker, exchange, context);
    return support.map((entry) => entry.resolution);
  }

  async getDetailedPriceHistory(
    ticker: string,
    exchange: string,
    startDate: Date,
    endDate: Date,
    barSize: string,
    context?: MarketDataRequestContext,
  ): Promise<PricePoint[]> {
    const primaryParts: Array<[string, string | number | undefined | null]> = [
      ["exchange", canonicalExchange(exchange)],
      ["start", compactDate(startDate)],
      ["end", compactDate(endDate)],
      ["bar", barSize],
    ];
    const fallbackParts = primaryParts.slice(1);
    const identity = makeHistoryRequestIdentity(this.deps, {
      kind: "detailed-price-history",
      ticker,
      exchange,
      context,
      variantParts: primaryParts,
      fallbackVariantParts: fallbackParts,
    });
    const currentWindowAtLookup = isCurrentHistoryWindow(endDate);
    const intervalMs = priceHistoryIntervalMs(barSize);
    return this.executeHistoryRequest({
      ...identity,
      requestedStart: startDate.getTime(),
      context,
      cachePolicyKey: intervalMs != null && intervalMs >= 24 * 60 * 60 * 1000 ? "priceHistoryDaily" : "priceHistoryIntraday",
      isCachedValueStale: (value) => currentWindowAtLookup
        && isPriceHistoryStaleForCurrentWindow(value, Date.now(), { exchange, intervalMs }),
      isFetchedValueStale: (value) => isCurrentHistoryWindow(endDate)
        && isPriceHistoryStaleForCurrentWindow(value, Date.now(), { exchange, intervalMs }),
      fetchBroker: async (candidate) => candidate.broker.getDetailedPriceHistory
        ? candidate.broker.getDetailedPriceHistory(
          ticker,
          candidate.instance,
          exchange,
          startDate,
          endDate,
          barSize,
          context?.instrument ?? null,
        )
        : null,
      fetchProvider: async (provider) => provider.getDetailedPriceHistory
        ? provider.getDetailedPriceHistory(ticker, exchange, startDate, endDate, barSize, context)
        : null,
    });
  }

  private async executeHistoryRequest(request: HistoryRequestDescriptor): Promise<PricePoint[]> {
    const brokerCandidates = this.deps.getBrokerCandidatesForContext(request.context, false);
    const sourceKeys = [
      ...brokerCandidates.map((candidate) => this.deps.brokerSourceKey(candidate)),
      ...this.deps.getProviderSourceKeys(),
    ];
    const cachedRecords = listCachedResources<PricePoint[]>(
      this.deps.resources,
      request.identity.kind,
      request.identity.entityKey,
      request.cacheVariantKeys,
      sourceKeys,
      false,
    ).filter((record) => request.cachePolicyKey === "priceHistoryIntraday"
      || !hasUnverifiedShellHistory(record.value, request.target, record.sourceKey, request.requestedStart));
    const cached = cachedRecords.find((record) => record.value.length > 0) ?? cachedRecords[0] ?? null;
    const cachedValue = cached ? normalizeRequestHistory(cached.value, request) : [];
    const cachedHistoryStale = request.isCachedValueStale(cachedValue);
    const forceRefresh = request.context?.cacheMode === "refresh";
    const usableCached = cachedValue.length > 0 && cached && !cached.expired && !cachedHistoryStale;
    if (usableCached && !forceRefresh) {
      const exactHit = request.exactCacheVariantKeys.includes(cached.variantKey);
      if (cached.stale && exactHit) {
        scheduleRouterRevalidation(this.historyRefreshInFlight, request.identity.revalidationKey, () => this.refreshHistory(request));
      }
      return exactHit || !request.requestedRange
        ? cachedValue
        : clipPriceHistoryToRange(cachedValue, request.requestedRange);
    }

    const brokerResult = await withBrokerTimeout(this.fetchBrokerHistory(request, brokerCandidates));
    if (brokerResult && brokerResult.value.length > 0) return brokerResult.value;

    let coverageError: HistoryCoverageError | null = null;
    const providerResult = await this.fetchProviderHistory(request).catch((error: unknown) => {
      if (!(error instanceof HistoryCoverageError)) throw error;
      coverageError = error;
      return null;
    });
    if (providerResult && providerResult.value.length > 0) return providerResult.value;
    if (cachedValue.length > 0 && !cachedHistoryStale) {
      return request.requestedRange
        ? clipPriceHistoryToRange(cachedValue, request.requestedRange)
        : cachedValue;
    }
    if (coverageError) throw coverageError;
    if (!providerResult && request.missingProviderError) {
      throw new Error(request.missingProviderError);
    }
    return providerResult?.value ?? [];
  }

  private async refreshHistory(request: HistoryRequestDescriptor): Promise<void> {
    const brokerCandidates = this.deps.getBrokerCandidatesForContext(request.context, false);
    try {
      const brokerResult = await withBrokerTimeout(this.fetchBrokerHistory(request, brokerCandidates));
      if (brokerResult && brokerResult.value.length > 0) return;
      await this.fetchProviderHistory(request);
    } catch {
      // Background refresh is best-effort; callers already have cached points.
    }
  }

  private fetchBrokerHistory(
    request: HistoryRequestDescriptor,
    candidates: BrokerCandidate[],
  ): Promise<SourceResult<PricePoint[]> | null> {
    return this.firstBrokerResult(candidates, async (candidate) => {
      const fetched = await request.fetchBroker(candidate);
      if (fetched === null) return null;
      const value = normalizeRequestHistory(fetched, request);
      if (request.isFetchedValueStale(value)) return null;
      this.deps.cacheResource(
        request.identity.kind,
        request.identity.entityKey,
        request.identity.variantKey,
        this.deps.brokerSourceKey(candidate),
        value,
        this.deps.resolveBrokerPolicy(request.cachePolicyKey, candidate.broker),
      );
      return value;
    });
  }

  private fetchProviderHistory(request: HistoryRequestDescriptor): Promise<SourceResult<PricePoint[]> | null> {
    return this.firstProviderArrayResult(async (provider) => {
      const fetched = await request.fetchProvider(provider);
      if (fetched === null) return null;
      if (request.cachePolicyKey !== "priceHistoryIntraday"
        && hasUnverifiedShellHistory(fetched, request.target, this.deps.providerSourceKey(provider))) return null;
      const value = normalizeRequestHistory(fetched, request);
      if (request.isFetchedValueStale(value)) return null;
      this.deps.cacheResource(
        request.identity.kind,
        request.identity.entityKey,
        request.identity.variantKey,
        this.deps.providerSourceKey(provider),
        value,
        this.deps.resolveProviderPolicy(request.cachePolicyKey, provider),
      );
      return value;
    });
  }

  private async firstBrokerResult<T>(
    candidates: BrokerCandidate[],
    fetch: (candidate: BrokerCandidate) => Promise<T | null>,
  ): Promise<SourceResult<T> | null> {
    for (const candidate of candidates) {
      try {
        const value = await fetch(candidate);
        if (value !== null) {
          return { sourceKey: this.deps.brokerSourceKey(candidate), value };
        }
      } catch {
        // Continue through the broker candidates.
      }
    }
    return null;
  }

  private async firstProviderArrayResult<T>(
    fetch: (provider: DataProvider) => Promise<T[] | null>,
  ): Promise<SourceResult<T[]> | null> {
    const providers = this.deps.providersInPriorityOrder();
    let firstEmptyResult: SourceResult<T[]> | null = null;
    let coverageError: HistoryCoverageError | null = null;
    const tryProvider = async (provider: DataProvider): Promise<SourceResult<T[]> | null> => {
      try {
        const value = await fetch(provider);
        if (value === null) return null;
        const result = { sourceKey: this.deps.providerSourceKey(provider), value };
        if (value.length === 0) firstEmptyResult ??= result;
        return result;
      } catch (error) {
        if (error instanceof HistoryCoverageError) coverageError ??= error;
        if (shouldLogProviderError(error)) {
          this.deps.logProviderError(`${provider.id} failed: ${error}`);
        }
        return null;
      }
    };

    if (providers.length <= 1) {
      for (const provider of providers) {
        const result = await tryProvider(provider);
        if (result && result.value.length > 0) return result;
      }
      if (coverageError) throw coverageError;
      return firstEmptyResult;
    }

    const preferred = tryProvider(providers[0]!);
    const speculativeDelay = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), 200);
    });
    const first = await Promise.race([preferred, speculativeDelay]);
    if (first !== "timeout" && first && first.value.length > 0) return first;

    const remaining = providers.slice(1).map((provider) => tryProvider(provider));
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (result: SourceResult<T[]> | null) => {
        if (settled || !result || result.value.length === 0) return;
        settled = true;
        resolve(result);
      };
      void preferred.then((result) => {
        if (result && result.value.length > 0) finish(result);
      });
      for (const pending of remaining) {
        void pending.then(finish);
      }
      void Promise.all([preferred, ...remaining]).then(() => {
        if (!settled) {
          if (coverageError) reject(coverageError);
          else resolve(firstEmptyResult);
        }
      });
    });
  }
}
