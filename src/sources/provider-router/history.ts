import type { BrokerCandidate } from "./brokers";
import { withBrokerTimeout } from "./brokers";
import type { DataProvider, MarketDataRequestContext } from "../../types/data-provider";
import type { PricePoint } from "../../types/financials";
import type { TimeRange } from "../../time-series/range";
import {
  isIntradayResolution,
  normalizeChartResolutionSupport,
  type ChartResolutionSupport,
  type ManualChartResolution,
} from "../../time-series/resolution";
import { canonicalExchange } from "../../utils/exchanges";
import { resolvePriceHistoryCurrencyUnit } from "../../utils/currency-units";
import { isPriceHistoryStaleForCurrentWindow, normalizePriceHistory } from "../../utils/price-history";
import { shouldLogProviderError } from "../provider-errors";
import {
  buildVariantKey,
  compactDate,
  isCurrentHistoryWindow,
  isIntradayRange,
  isStaleIntradayHistory,
  selectCachedArrayResource,
  type ProviderRouterCachePolicyKey,
} from "./cache";
import type { ProviderRouterCoreDeps, SourceResult } from "./route-types";
import { makeRouterRequestIdentity, type RouterRequestIdentity } from "./routing";

type PriceHistoryCachePolicyKey = Extract<
  ProviderRouterCachePolicyKey,
  "priceHistoryIntraday" | "priceHistoryDaily"
>;

interface HistoryRequestDescriptor {
  identity: RouterRequestIdentity;
  cacheVariantKeys: string[];
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
): Array<[string, string | number | undefined | null]> {
  const unit = resolvePriceHistoryCurrencyUnit(null, exchange);
  return unit.divisor === 1 ? parts : [...parts, ["unit", unit.currency]];
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
): Pick<HistoryRequestDescriptor, "identity" | "cacheVariantKeys"> {
  const identity = makeRouterRequestIdentity(deps, {
    kind: input.kind,
    ticker: input.ticker,
    context: input.context,
    variantParts: priceHistoryVariantParts(input.variantParts, input.exchange),
  });
  return {
    identity,
    cacheVariantKeys: [
      identity.variantKey,
      buildVariantKey(priceHistoryVariantParts(input.fallbackVariantParts, input.exchange)),
    ],
  };
}

export class ProviderRouterHistoryRoutes {
  constructor(private readonly deps: ProviderRouterCoreDeps) {}

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
    return this.executeHistoryRequest({
      ...identity,
      context,
      cachePolicyKey: intraday ? "priceHistoryIntraday" : "priceHistoryDaily",
      missingProviderError: `No resolution-aware history provider available for ${ticker}`,
      isCachedValueStale: (value) => isStaleIntradayHistory(value, intraday, exchange),
      isFetchedValueStale: (value) => isStaleIntradayHistory(value, intraday, exchange),
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
    return this.executeHistoryRequest({
      ...identity,
      context,
      cachePolicyKey: "priceHistoryIntraday",
      isCachedValueStale: (value) => currentWindowAtLookup
        && isPriceHistoryStaleForCurrentWindow(value, Date.now(), { exchange }),
      isFetchedValueStale: (value) => isCurrentHistoryWindow(endDate)
        && isPriceHistoryStaleForCurrentWindow(value, Date.now(), { exchange }),
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
    const cached = selectCachedArrayResource<PricePoint>(
      this.deps.resources,
      request.identity.kind,
      request.identity.entityKey,
      request.cacheVariantKeys,
      sourceKeys,
      false,
    );
    const cachedValue = cached ? normalizePriceHistory(cached.value) : [];
    const cachedHistoryStale = request.isCachedValueStale(cachedValue);
    const forceRefresh = request.context?.cacheMode === "refresh";
    if (cachedValue.length > 0 && !forceRefresh && cached && !cached.stale && !cachedHistoryStale) {
      return cachedValue;
    }

    const brokerResult = await withBrokerTimeout(this.fetchBrokerHistory(request, brokerCandidates));
    if (brokerResult && brokerResult.value.length > 0) return brokerResult.value;

    const providerResult = await this.fetchProviderHistory(request);
    if (providerResult && providerResult.value.length > 0) return providerResult.value;
    if (cachedValue.length > 0 && !cachedHistoryStale) return cachedValue;
    if (!providerResult && request.missingProviderError) {
      throw new Error(request.missingProviderError);
    }
    return providerResult?.value ?? [];
  }

  private fetchBrokerHistory(
    request: HistoryRequestDescriptor,
    candidates: BrokerCandidate[],
  ): Promise<SourceResult<PricePoint[]> | null> {
    return this.firstBrokerResult(candidates, async (candidate) => {
      const fetched = await request.fetchBroker(candidate);
      if (fetched === null) return null;
      const value = normalizePriceHistory(fetched);
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
      const value = normalizePriceHistory(fetched);
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
    let firstEmptyResult: SourceResult<T[]> | null = null;
    for (const provider of this.deps.providersInPriorityOrder()) {
      try {
        const value = await fetch(provider);
        if (value === null) continue;
        const result = { sourceKey: this.deps.providerSourceKey(provider), value };
        if (value.length > 0) return result;
        firstEmptyResult ??= result;
      } catch (error) {
        if (shouldLogProviderError(error)) {
          this.deps.logProviderError(`${provider.id} failed: ${error}`);
        }
      }
    }
    return firstEmptyResult;
  }
}
