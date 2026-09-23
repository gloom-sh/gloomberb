import { assertTradingPriceHistory, hasCircleOfferingPriceHistory } from "../listing-history";
import { ApiRequestError } from "../../api-client/errors";
import { canonicalHistoryInterval, HistoryRetentionError, isHistoryRetentionError, parseHistoryRecoveryCandidate,
  type HistoryRecoveryCandidate, type HistoryRetention, type HistorySourceOutcome } from "../history-retention";
import type { BrokerCandidate } from "./brokers";
import { withBrokerTimeout } from "./brokers";
import type { DataProvider, MarketDataRequestContext } from "../../types/data-provider";
import type { PriceHistoryResult } from "../../types/price-history";
import { fetchHistoryResult, historyResolutionForInterval, InvalidHistoryResultError, normalizeHistoryResult } from "../history-result";
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
import { canonicalExchange, parsePublicTickerKey, resolveExchangeTimeZone } from "../../utils/exchanges";
import { zonedDateTimeParts } from "../../utils/zoned-date-time";
import { resolvePriceHistoryCurrencyUnit } from "../../utils/currency-units";
import { calendarHistoryFetchState, calendarHistoryLastBarDate, getPricePointTimestamp, hasUsablePriceHistory, preservePriceHistoryGaps, isPriceHistoryStaleForCurrentWindow, normalizePriceHistory, priceHistoryIntervalMs, type CalendarHistoryFetchState } from "../../utils/price-history";
import { shouldLogProviderError } from "../provider-errors";
import { hasUnverifiedShellHistory, HistoryCoverageError } from "../history-coverage";
import {
  buildVariantKey,
  compactDate,
  isCurrentHistoryWindow,
  isIntradayRange,
  listCachedResources,
  type ProviderRouterCachePolicyKey,
} from "./cache";
import type { ProviderRouterCoreDeps, SourceResult } from "./route-types";
import { makeRouterRequestIdentity, scheduleRouterRevalidation, type RouterRequestIdentity } from "./routing";

type PriceHistoryCachePolicyKey = Extract<
  ProviderRouterCachePolicyKey,
  "priceHistoryIntraday" | "priceHistoryDaily"
>;
// Earlier cache records discarded dated unavailable closes.
const PRICE_HISTORY_CACHE_VERSION = 5;
interface HistoryRequestDescriptor {
  target: { symbol: string; exchange: string };
  identity: RouterRequestIdentity;
  cacheVariantKeys: string[];
  exactCacheVariantKeys: string[];
  requestedRange?: TimeRange;
  requestedStart: number;
  requestedEnd?: number;
  interval?: string;
  method: "getPriceHistory" | "getPriceHistoryForResolution" | "getDetailedPriceHistory";
  context?: MarketDataRequestContext;
  cachePolicyKey: PriceHistoryCachePolicyKey;
  missingProviderError?: string;
  isCachedValueStale(value: PriceHistoryResult): boolean;
  isFetchedValueStale(value: PriceHistoryResult): boolean;
  fetchBroker(candidate: BrokerCandidate): Promise<PricePoint[] | null>;
  fetchProvider(provider: DataProvider): Promise<PriceHistoryResult | null>;
}

interface HistoryAttempts {
  outcomes: Map<string, HistorySourceOutcome>;
  candidates: Map<string, HistoryRecoveryCandidate>;
  pending: Set<string>;
  coverageError?: HistoryCoverageError;
  retention?: HistoryRetention;
}

function recordHistoryOutcome(attempts: HistoryAttempts | undefined, sourceKey: string, outcome: HistorySourceOutcome["outcome"], status?: number): void {
  if (!attempts) return;
  attempts.pending.delete(sourceKey);
  attempts.outcomes.set(sourceKey, { sourceKey, outcome, ...(status !== undefined ? { status } : {}) });
}

function retentionForRequest(request: HistoryRequestDescriptor, sourceKey: string, error: HistoryRetentionError): HistoryRetention | null {
  if (!sourceKey.startsWith("provider:") || !request.interval) return null;
  const retention = error.retention;
  const target = parsePublicTickerKey(request.target.symbol);
  const exchange = target.exchange || canonicalExchange(request.target.exchange);
  if (retention.symbol !== target.symbol || retention.exchange !== exchange
    || retention.interval !== canonicalHistoryInterval(request.interval)) return null;
  // Trailing providers choose their actual clock bounds themselves. The typed
  // source owns those bounds; explicit detailed requests additionally match them.
  if (request.method === "getDetailedPriceHistory"
    && (retention.requestedStart !== Math.floor(request.requestedStart / 1000) * 1000
      || retention.requestedEnd !== Math.floor(Number(request.requestedEnd) / 1000) * 1000)) return null;
  return retention;
}

function candidateForRequest(request: HistoryRequestDescriptor, sourceKey: string, error: HistoryRetentionError): HistoryRecoveryCandidate | null {
  const retention = retentionForRequest(request, sourceKey, error);
  if (!retention) return null;
  const brokerId = request.context?.instrument?.brokerId ?? request.context?.brokerId;
  const brokerInstanceId = request.context?.instrument?.brokerInstanceId ?? request.context?.brokerInstanceId;
  return parseHistoryRecoveryCandidate({ sourceKey, retention, request: {
    symbol: retention.symbol, exchange: retention.exchange, interval: retention.interval, entityKey: request.identity.entityKey,
    ...(brokerId !== undefined ? { brokerId } : {}), ...(brokerInstanceId !== undefined ? { brokerInstanceId } : {}),
    requestedStart: retention.requestedStart, requestedEnd: retention.requestedEnd,
  } });
}

function recordHistoryError(attempts: HistoryAttempts | undefined, request: HistoryRequestDescriptor, sourceKey: string, error: unknown): void {
  if (!attempts) return;
  if (error instanceof InvalidHistoryResultError) {
    recordHistoryOutcome(attempts, sourceKey, "malformed");
  } else if (isHistoryRetentionError(error)) {
    recordHistoryOutcome(attempts, sourceKey, "retention");
    attempts.retention ??= retentionForRequest(request, sourceKey, error) ?? undefined;
    const candidate = candidateForRequest(request, sourceKey, error);
    if (candidate) attempts.candidates.set(sourceKey, candidate);
  } else if (error instanceof HistoryCoverageError) {
    recordHistoryOutcome(attempts, sourceKey, "coverage");
    attempts.coverageError ??= error;
  } else {
    const status = error instanceof ApiRequestError ? error.status : undefined;
    recordHistoryOutcome(attempts, sourceKey, status === 401 || status === 403 ? "auth" : status === 429 ? "rate-limit"
      : status === 408 || (status !== undefined && status >= 500) ? "transient" : "failure", status);
  }
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
    ["historyData", 1],
    ["inception", inceptionVersion],
    ["calendar", monthly ? 1 : undefined],
    // Old Yahoo/cloud ALL responses could serve weekly/quarterly bars under
    // a different requested interval. Exact and broader cache lookups must
    // refetch these windows instead of relabeling the cached bars.
    ["granularity", range === "ALL" ? 1 : undefined],
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
  ].flatMap((key) => {
    // Broker and independent-provider records did not use the affected Yahoo
    // request. Keep their old keys readable, then filter by source below.
    const legacy = key.replace(/;granularity=1(?=;|$)/, "");
    const keys = legacy === key ? [key] : [key, legacy];
    // New result envelopes never overwrite array payloads used by older clients.
    return keys.flatMap(value => [value, value.replace(/;historyData=1(?=;|$)/, "")]);
  });
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

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
// A broader cached range can answer a narrower range only at a bar size the
// narrower range uses itself. Weekly 5Y bars clipped to 1M hide the current
// week, and a weekly series is never judged stale.
const MAX_RANGE_BAR_MS: Record<TimeRange, number> = {
  "1D": 15 * 60_000, "1W": HOUR_MS, "1M": DAY_MS, "3M": DAY_MS, "6M": DAY_MS, "1Y": DAY_MS, "5Y": 7 * DAY_MS, ALL: Infinity,
};

function hasRangeBarSize(points: PricePoint[], range: TimeRange): boolean {
  const limit = MAX_RANGE_BAR_MS[range];
  if (limit === undefined || limit === Infinity) return true;
  const times = [...new Set(points.slice(-40).map(getPricePointTimestamp).filter(Number.isFinite))].sort((a, b) => a - b);
  let shortest = Infinity;
  for (let index = 1; index < times.length; index++) shortest = Math.min(shortest, times[index]! - times[index - 1]!);
  // Daily and weekly labels at exchange opens move by an hour across DST.
  return shortest <= (limit >= DAY_MS ? limit + HOUR_MS : limit);
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

function mergeRequestHistoryGaps(
  value: PricePoint[], unavailable: readonly PricePoint[][], range?: TimeRange,
): PricePoint[] {
  if (!range || range === "ALL") return preservePriceHistoryGaps(value, unavailable);
  if (!hasUsablePriceHistory(value)) return clipPriceHistoryToRange(preservePriceHistoryGaps(value, unavailable), range);
  // A broader cache cannot move the selected response's window or add older dates.
  const end = value.reduce((latest, point) => Math.max(latest, getPricePointTimestamp(point)), Number.NEGATIVE_INFINITY);
  if (!Number.isFinite(end)) return value;
  const start = subtractTimeRange(new Date(end), range).getTime();
  return preservePriceHistoryGaps(value, unavailable.map((points) => points.filter((point) => {
    const time = getPricePointTimestamp(point);
    return time >= start && time <= end;
  })));
}

function normalizeRequestResult(value: PriceHistoryResult, request: HistoryRequestDescriptor): PriceHistoryResult {
  return { ...value, points: normalizeRequestHistory(value.points, request),
    // A public equity response cannot establish a broker contract's session.
    ...(request.context?.instrument ? { session: undefined } : {}),
  };
}

function resultIsStale(value: PriceHistoryResult, exchange: string, intervalMs?: number | null): boolean {
  return isPriceHistoryStaleForCurrentWindow(value.points, Date.now(), {
    exchange, intervalMs: intervalMs ?? (value.resolution ? priceHistoryIntervalMs(value.resolution) : undefined), session: value.session,
  });
}

// Longer than any intraday break (lunch, futures maintenance), shorter than a night.
const SESSION_BREAK_MS = 3 * 3_600_000;

function localDate(time: number, timeZone: string): string {
  const { year, month, day } = zonedDateTimeParts(time, timeZone);
  return `${year}-${month}-${day}`;
}

/**
 * 1D is the latest session. A broader cached range clipped to the trailing
 * 24 hours would otherwise also keep the previous session's afternoon, so cut
 * at the last overnight break. Round-the-clock markets have none, and a thin
 * listing's quiet hours within one local day are not a break.
 */
function clipHistoryToRange(value: PriceHistoryResult, range: TimeRange, exchange: string): PriceHistoryResult {
  const points = clipPriceHistoryToRange(value.points, range);
  if (range !== "1D") return { ...value, points };
  const timeZone = value.session?.timeZone ?? resolveExchangeTimeZone(exchange);
  const times = points.map(getPricePointTimestamp);
  const breakIndex = times.findLastIndex((time, index) => index > 0 && time - times[index - 1]! >= SESSION_BREAK_MS
    && (!timeZone || localDate(time, timeZone) !== localDate(times[index - 1]!, timeZone)));
  return { ...value, points: breakIndex > 0 ? points.slice(breakIndex) : points };
}

function historyCoverage(request: HistoryRequestDescriptor) {
  return {
    isUsable: (value: PriceHistoryResult) => hasUsablePriceHistory(value.points),
    merge: (value: PriceHistoryResult, unavailable: PriceHistoryResult[]) => ({ ...value,
      points: mergeRequestHistoryGaps(value.points, unavailable.map(result => result.points), request.requestedRange) }),
  };
}

const CALENDAR_RECHECK_MARKER_POLICY = { staleMs: 7 * DAY_MS, expireMs: 7 * DAY_MS };

function calendarRecheckMarkerKey(request: HistoryRequestDescriptor) {
  return { namespace: "market", kind: "price-history-recheck", entityKey: request.identity.entityKey,
    variantKey: request.identity.variantKey, sourceKey: "router" };
}

export class ProviderRouterHistoryRoutes {
  constructor(private readonly deps: ProviderRouterCoreDeps) {}
  private readonly historyRefreshInFlight = new Map<string, Promise<unknown>>();
  private readonly calendarRecheckAt = new Map<string, number>();

  /** The latest calendar re-check of this request, kept with the cache so it binds every process. */
  private calendarCheckedAt(request: HistoryRequestDescriptor): number | undefined {
    let persisted: number | undefined;
    try {
      const marker = this.deps.resources?.get<{ checkedAt?: unknown }>(calendarRecheckMarkerKey(request));
      if (typeof marker?.value?.checkedAt === "number") persisted = marker.value.checkedAt;
    } catch {
      // Without the store, the in-memory mark bounds this process.
    }
    const local = this.calendarRecheckAt.get(request.identity.revalidationKey);
    return persisted === undefined ? local : local === undefined ? persisted : Math.max(persisted, local);
  }

  private markCalendarChecked(request: HistoryRequestDescriptor, checkedAt: number): void {
    if (this.calendarRecheckAt.size >= 4096) this.calendarRecheckAt.clear();
    this.calendarRecheckAt.set(request.identity.revalidationKey, checkedAt);
    try {
      this.deps.resources?.set(calendarRecheckMarkerKey(request), { checkedAt }, { cachePolicy: CALENDAR_RECHECK_MARKER_POLICY });
    } catch {
      // Without the store, the in-memory mark bounds this process.
    }
  }

  async getPriceHistory(ticker: string, exchange: string, range: TimeRange, context?: MarketDataRequestContext): Promise<PricePoint[]> {
    return (await this.getPriceHistoryWithMetadata(ticker, exchange, range, context)).points;
  }

  async getPriceHistoryWithMetadata(
    ticker: string,
    exchange: string,
    range: TimeRange,
    context?: MarketDataRequestContext,
  ): Promise<PriceHistoryResult> {
    if (context?.historyRecovery) throw new Error("History recovery requires an exact detailed request");
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
      method: "getPriceHistory",
      context,
      cachePolicyKey: intraday ? "priceHistoryIntraday" : "priceHistoryDaily",
      missingProviderError: `No history provider available for ${ticker}`,
      isCachedValueStale: (value) => intraday && resultIsStale(value, exchange),
      isFetchedValueStale: (value) => intraday && resultIsStale(value, exchange),
      fetchBroker: async (candidate) => candidate.broker.getPriceHistory
        ? candidate.broker.getPriceHistory(
          ticker,
          candidate.instance,
          exchange,
          range,
          context?.instrument ?? null,
        )
        : null,
      fetchProvider: (provider) => fetchHistoryResult(provider, ticker, exchange, { kind: "range", range }, context),
    });
  }

  async getPriceHistoryForResolution(ticker: string, exchange: string, bufferRange: TimeRange, resolution: ManualChartResolution, context?: MarketDataRequestContext): Promise<PricePoint[]> {
    return (await this.getPriceHistoryForResolutionWithMetadata(ticker, exchange, bufferRange, resolution, context)).points;
  }

  async getPriceHistoryForResolutionWithMetadata(
    ticker: string,
    exchange: string,
    bufferRange: TimeRange,
    resolution: ManualChartResolution,
    context?: MarketDataRequestContext,
  ): Promise<PriceHistoryResult> {
    if (context?.historyRecovery) throw new Error("History recovery requires an exact detailed request");
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
      method: "getPriceHistoryForResolution",
      interval: resolution,
      context,
      cachePolicyKey: intraday ? "priceHistoryIntraday" : "priceHistoryDaily",
      missingProviderError: `No resolution-aware history provider available for ${ticker}`,
      isCachedValueStale: (value) => intraday && resultIsStale(value, exchange, intervalMs),
      isFetchedValueStale: (value) => intraday && resultIsStale(value, exchange, intervalMs),
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
      fetchProvider: (provider) => fetchHistoryResult(provider, ticker, exchange, { kind: "resolution", range: bufferRange, resolution }, context),
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

    const providerSupport = await this.firstProviderResult(async (provider) => {
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

  async getDetailedPriceHistory(ticker: string, exchange: string, startDate: Date, endDate: Date, barSize: string, context?: MarketDataRequestContext): Promise<PricePoint[]> {
    return (await this.getDetailedPriceHistoryWithMetadata(ticker, exchange, startDate, endDate, barSize, context)).points;
  }

  async getDetailedPriceHistoryWithMetadata(
    ticker: string,
    exchange: string,
    startDate: Date,
    endDate: Date,
    barSize: string,
    context?: MarketDataRequestContext,
  ): Promise<PriceHistoryResult> {
    const intervalMs = priceHistoryIntervalMs(barSize);
    const calendarBounds = intervalMs !== null
      && /^\d+\s*(d|day|days|w|wk|week|weeks|mo|month|months)$/i.test(barSize.trim());
    // Intraday requests forward exact times. Date-only keys could reuse another
    // window or suppress its refresh; ISO bounds also bypass those legacy keys.
    const primaryParts: Array<[string, string | number | undefined | null]> = [
      ["exchange", canonicalExchange(exchange)],
      ["start", calendarBounds ? compactDate(startDate) : startDate.toISOString()],
      ["end", calendarBounds ? compactDate(endDate) : endDate.toISOString()],
      ["bar", barSize],
      // An ordinary Cloud cache does not identify its internal winning source.
      // Scoped recovery must only reuse a cache explicitly acquired this way.
      ["historyRecovery", context?.historyRecovery ? "yahoo" : undefined],
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
      requestedStart: startDate.getTime(),
      requestedEnd: endDate.getTime(),
      method: "getDetailedPriceHistory",
      interval: barSize,
      context,
      cachePolicyKey: intervalMs != null && intervalMs >= 24 * 60 * 60 * 1000 ? "priceHistoryDaily" : "priceHistoryIntraday",
      isCachedValueStale: (value) => currentWindowAtLookup
        && resultIsStale(value, exchange, intervalMs),
      isFetchedValueStale: (value) => isCurrentHistoryWindow(endDate)
        && resultIsStale(value, exchange, intervalMs),
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
      fetchProvider: (provider) => fetchHistoryResult(provider, ticker, exchange, { kind: "detail", start: startDate, end: endDate, interval: barSize }, context),
    });
  }

  private async executeHistoryRequest(request: HistoryRequestDescriptor): Promise<PriceHistoryResult> {
    const recovery = this.validateRecovery(request);
    const brokerCandidates = recovery ? [] : this.deps.getBrokerCandidatesForContext(request.context, false);
    const sourceKeys = recovery ? [recovery.sourceKey] : [
      ...brokerCandidates.map((candidate) => this.deps.brokerSourceKey(candidate)),
      ...this.deps.getProviderSourceKeys(),
    ];
    const cachedRecords = listCachedResources<unknown>(
      this.deps.resources,
      request.identity.kind,
      request.identity.entityKey,
      request.cacheVariantKeys,
      sourceKeys,
      false,
    ).flatMap((record) => {
      const legacy = !/(?:^|;)historyData=1(?:;|$)/.test(record.variantKey);
      const value = legacy && Array.isArray(record.value)
        ? { points: record.value as PricePoint[], resolution: historyResolutionForInterval(request.interval) }
        : !legacy ? normalizeHistoryResult(record.value, request.target, request.interval) : null;
      if (!value) return [];
      // Source identity belongs to the selected cache record, not its payload.
      return [{ ...record, value: normalizeRequestResult({ ...value, sourceKey: record.sourceKey }, request) }];
    }).filter((record) => {
      const unverifiedAllInterval = ["provider:yahoo", "provider:gloomberb-cloud"].includes(record.sourceKey)
        && /(?:^|;)range=ALL(?:;|$)/.test(record.variantKey)
        && !/(?:^|;)granularity=1(?:;|$)/.test(record.variantKey);
      if (unverifiedAllInterval || hasCircleOfferingPriceHistory(record.value.points, request.target, record.sourceKey)) return false;
      if (request.requestedRange && !request.interval && !request.exactCacheVariantKeys.includes(record.variantKey)
        && !hasRangeBarSize(record.value.points, request.requestedRange)) return false;
      return request.cachePolicyKey === "priceHistoryIntraday"
        || !hasUnverifiedShellHistory(record.value.points, request.target, record.sourceKey, request.requestedStart);
    });
    // A background revalidation cannot correct bars from before a close in
    // time: a one-shot CLI exits first, and this caller keeps the old bars.
    // Broader variants answer the same way. A current copy under another key
    // (such as the refetch of this range) answers first. Next come copies
    // fetched after the latest settled close that are behind, due a re-check
    // or not, the one reaching furthest first. A copy fetched before that close
    // answers only when no later copy exists: its latest bar may be the session
    // in progress, and ranking it by that bar would refetch on every request
    // without ever replacing it.
    const target = parsePublicTickerKey(request.target.symbol);
    const currentWindow = request.requestedEnd === undefined || isCurrentHistoryWindow(new Date(request.requestedEnd));
    const now = Date.now();
    const fetchState = (record: { fetchedAt: number; value: PriceHistoryResult }, checkedAt?: number): CalendarHistoryFetchState => currentWindow
      ? calendarHistoryFetchState(record.value.points, record.fetchedAt, now, {
        exchange: target.exchange || request.target.exchange,
        checkedAt,
        // Bar size comes from the request: a cached weekly or monthly series
        // can end in a trade-time row that hides its cadence.
        intervalMs: record.value.resolution ? priceHistoryIntervalMs(record.value.resolution)
          : request.cachePolicyKey === "priceHistoryDaily" ? DAY_MS : undefined,
      })
      : "current";
    const fetchTier: Record<CalendarHistoryFetchState, number> = { current: 0, behind: 1, recheck: 1, pending: 2, unsettled: 2 };
    const ranked = cachedRecords.filter((record) => hasUsablePriceHistory(record.value.points)).map((record) => {
      const tier = fetchTier[fetchState(record)];
      return { record, tier, exact: request.exactCacheVariantKeys.includes(record.variantKey),
        lastBar: tier === 0 ? "" : calendarHistoryLastBarDate(record.value.points, target.exchange || request.target.exchange) ?? "" };
    });
    // Current copies keep their listed order. Otherwise ties go to this key's
    // own copy, then the latest fetch, rather than to row order.
    ranked.sort((a, b) => a.tier - b.tier || (a.tier === 0 ? 0 : b.lastBar.localeCompare(a.lastBar)
      || Number(b.exact) - Number(a.exact) || b.record.fetchedAt - a.record.fetchedAt));
    const cached = ranked[0]?.record ?? cachedRecords[0] ?? null;
    const cachedValue: PriceHistoryResult = cached?.value ?? { points: [], resolution: historyResolutionForInterval(request.interval) };
    const reportedGaps = cachedRecords.map((record) => record.value)
      .filter((value) => !hasUsablePriceHistory(value.points));
    const withReportedGaps = (value: PriceHistoryResult) => historyCoverage(request).merge(value, reportedGaps);
    const clip = (value: PriceHistoryResult) => request.requestedRange
      ? clipHistoryToRange(value, request.requestedRange, request.target.exchange) : value;
    const cachedHistoryStale = request.isCachedValueStale(cachedValue);
    const forceRefresh = request.context?.cacheMode === "refresh";
    // A recent re-check, even a failed, empty or rejected one, defers the next
    // one; it does not make the copy current. A broader copy only tells what
    // its own key answered, so this key is asked at least once.
    const servedState = cached ? fetchState(cached, Math.max(this.calendarCheckedAt(request) ?? Number.NEGATIVE_INFINITY,
      request.exactCacheVariantKeys.includes(cached.variantKey) ? cached.fetchedAt : Number.NEGATIVE_INFINITY)) : "current";
    const cachedBeforeClose = servedState === "unsettled" || servedState === "recheck";
    if (cachedBeforeClose) this.markCalendarChecked(request, now);
    const usableCached = hasUsablePriceHistory(cachedValue.points) && cached && !cached.expired && !cachedHistoryStale
      && !cachedBeforeClose;
    if (usableCached && !forceRefresh) {
      const exactHit = request.exactCacheVariantKeys.includes(cached.variantKey);
      // A copy behind or before the latest session is re-checked on the
      // paced schedule above, not on its short TTL: the source is likely to
      // answer the same.
      if (cached.stale && servedState === "current") {
        scheduleRouterRevalidation(this.historyRefreshInFlight, request.identity.revalidationKey, () => this.refreshHistory(request));
      }
      return exactHit || !request.requestedRange
        ? withReportedGaps(cachedValue)
        : clip(withReportedGaps(cachedValue));
    }

    const supersededCacheSources = new Set<string>();
    const onUnavailable = (sourceKey: string, value: PriceHistoryResult) => {
      if (value.points.length && !hasUsablePriceHistory(value.points)) supersededCacheSources.add(sourceKey);
    };
    const attempts: HistoryAttempts = { outcomes: new Map(), candidates: new Map(), pending: new Set() };
    const brokerResult = await withBrokerTimeout(this.fetchBrokerHistory(request, brokerCandidates, onUnavailable, attempts));
    for (const sourceKey of [...attempts.pending]) recordHistoryOutcome(attempts, sourceKey, "timeout");
    if (brokerResult && hasUsablePriceHistory(brokerResult.value.points)) return withReportedGaps(brokerResult.value);
    if (brokerResult) reportedGaps.push(brokerResult.value);

    let coverageError: HistoryCoverageError | null = null;
    const providerResult = await this.fetchProviderHistory(request, onUnavailable, attempts).catch((error: unknown) => {
      if (!(error instanceof HistoryCoverageError)) throw error;
      coverageError = error;
      return null;
    });
    if (providerResult && hasUsablePriceHistory(providerResult.value.points)) return withReportedGaps(providerResult.value);
    if (providerResult) reportedGaps.push(providerResult.value);
    const fallbackValue = cachedRecords
      .filter((record) => !supersededCacheSources.has(record.sourceKey))
      .map((record) => record.value)
      .find((value) => hasUsablePriceHistory(value.points) && !request.isCachedValueStale(value));
    if (fallbackValue) {
      return request.requestedRange
        ? clip(withReportedGaps(fallbackValue))
        : withReportedGaps(fallbackValue);
    }
    if (coverageError) throw coverageError;
    if (attempts.coverageError) throw attempts.coverageError;
    // Explicit reported gaps and usable original caches retain their existing
    // precedence. Only original source exhaustion exposes a recovery candidate.
    if (!reportedGaps.some((value) => value.points.length > 0) && !recovery && attempts.retention) {
      const sourceOrder = this.deps.getProviderSourceKeys();
      const candidates = [...attempts.candidates.values()].sort((a, b) => sourceOrder.indexOf(a.sourceKey) - sourceOrder.indexOf(b.sourceKey));
      throw new HistoryRetentionError(candidates[0]?.retention ?? attempts.retention, { candidates, outcomes: [...attempts.outcomes.values()] });
    }
    if (!providerResult && request.missingProviderError && !reportedGaps.some((value) => value.points.length > 0)) {
      throw new Error(request.missingProviderError);
    }
    return withReportedGaps(providerResult?.value ?? { points: [], resolution: historyResolutionForInterval(request.interval) });
  }

  private validateRecovery(request: HistoryRequestDescriptor): HistoryRecoveryCandidate | null {
    if (!request.context?.historyRecovery) return null;
    const candidate = parseHistoryRecoveryCandidate(request.context.historyRecovery);
    const target = parsePublicTickerKey(request.target.symbol);
    const brokerId = request.context.instrument?.brokerId ?? request.context.brokerId;
    const brokerInstanceId = request.context.instrument?.brokerInstanceId ?? request.context.brokerInstanceId;
    if (!candidate || request.method !== "getDetailedPriceHistory" || candidate.request.symbol !== target.symbol
      || candidate.request.exchange !== (target.exchange || canonicalExchange(request.target.exchange))
      || candidate.request.entityKey !== request.identity.entityKey || candidate.request.brokerId !== brokerId
      || candidate.request.brokerInstanceId !== brokerInstanceId || candidate.request.interval !== canonicalHistoryInterval(request.interval)
      || request.requestedStart < candidate.retention.availableStart || request.requestedStart >= Number(request.requestedEnd)
      || Number(request.requestedEnd) > candidate.retention.requestedEnd
      || !this.deps.providersInPriorityOrder().some((provider) => this.deps.providerSourceKey(provider) === candidate.sourceKey && (typeof provider.getDetailedPriceHistory === "function" || typeof provider.getDetailedPriceHistoryWithMetadata === "function"))) {
      throw new Error("Invalid or unavailable history recovery source");
    }
    return candidate;
  }

  private async refreshHistory(request: HistoryRequestDescriptor): Promise<void> {
    try {
      const recovery = this.validateRecovery(request);
      const brokerCandidates = recovery ? [] : this.deps.getBrokerCandidatesForContext(request.context, false);
      const brokerResult = await withBrokerTimeout(this.fetchBrokerHistory(request, brokerCandidates));
      if (brokerResult && hasUsablePriceHistory(brokerResult.value.points)) return;
      await this.fetchProviderHistory(request);
    } catch {
      // Background refresh is best-effort; callers already have cached points.
    }
  }

  private fetchBrokerHistory(
    request: HistoryRequestDescriptor,
    candidates: BrokerCandidate[],
    onUnavailable?: (sourceKey: string, value: PriceHistoryResult) => void,
    attempts?: HistoryAttempts,
  ): Promise<SourceResult<PriceHistoryResult> | null> {
    return this.firstBrokerResult(candidates, async (candidate) => {
      const sourceKey = this.deps.brokerSourceKey(candidate);
      if (typeof candidate.broker[request.method] !== "function") { recordHistoryOutcome(attempts, sourceKey, "missing-method"); return null; }
      attempts?.pending.add(sourceKey);
      try {
        const fetched = await request.fetchBroker(candidate);
        if (fetched === null) { recordHistoryOutcome(attempts, sourceKey, "empty"); return null; }
        if (!Array.isArray(fetched)) { recordHistoryOutcome(attempts, sourceKey, "malformed"); return null; }
        const value = normalizeRequestResult({ points: fetched, resolution: historyResolutionForInterval(request.interval), sourceKey }, request);
        if (hasUsablePriceHistory(value.points) && request.isFetchedValueStale(value)) { recordHistoryOutcome(attempts, sourceKey, "stale"); return null; }
        recordHistoryOutcome(attempts, sourceKey, hasUsablePriceHistory(value.points) ? "success" : value.points.length ? "reported-gaps" : "empty");
        onUnavailable?.(this.deps.brokerSourceKey(candidate), value);
        this.deps.cacheResource(
          request.identity.kind,
          request.identity.entityKey,
          request.identity.variantKey,
          this.deps.brokerSourceKey(candidate),
          value,
          this.deps.resolveBrokerPolicy(request.cachePolicyKey, candidate.broker),
        );
        return value;
      } catch (error) { recordHistoryError(attempts, request, sourceKey, error); throw error; }
    }, historyCoverage(request));
  }

  private fetchProviderHistory(
    request: HistoryRequestDescriptor,
    onUnavailable?: (sourceKey: string, value: PriceHistoryResult) => void,
    attempts?: HistoryAttempts,
  ): Promise<SourceResult<PriceHistoryResult> | null> {
    return this.firstProviderResult(async (provider) => {
      const sourceKey = this.deps.providerSourceKey(provider);
      if (typeof provider[request.method] !== "function" && typeof provider[`${request.method}WithMetadata`] !== "function") { recordHistoryOutcome(attempts, sourceKey, "missing-method"); return null; }
      attempts?.pending.add(sourceKey);
      try {
        const fetched = await request.fetchProvider(provider);
        if (fetched === null) { recordHistoryOutcome(attempts, sourceKey, "empty"); return null; }
        if (!Array.isArray(fetched.points)) { recordHistoryOutcome(attempts, sourceKey, "malformed"); return null; }
        assertTradingPriceHistory(fetched.points, request.target, this.deps.providerSourceKey(provider));
        if (request.cachePolicyKey !== "priceHistoryIntraday"
          && hasUnverifiedShellHistory(fetched.points, request.target, this.deps.providerSourceKey(provider))) { recordHistoryOutcome(attempts, sourceKey, "coverage"); return null; }
        const value = normalizeRequestResult({ ...fetched, sourceKey }, request);
        if (hasUsablePriceHistory(value.points) && request.isFetchedValueStale(value)) { recordHistoryOutcome(attempts, sourceKey, "stale"); return null; }
        recordHistoryOutcome(attempts, sourceKey, hasUsablePriceHistory(value.points) ? "success" : value.points.length ? "reported-gaps" : "empty");
        onUnavailable?.(this.deps.providerSourceKey(provider), value);
        this.deps.cacheResource(
          request.identity.kind,
          request.identity.entityKey,
          request.identity.variantKey,
          this.deps.providerSourceKey(provider),
          value,
          this.deps.resolveProviderPolicy(request.cachePolicyKey, provider),
        );
        return value;
      } catch (error) { recordHistoryError(attempts, request, sourceKey, error); throw error; }
    }, historyCoverage(request), request.context?.historyRecovery
      ? this.deps.providersInPriorityOrder().filter((provider) => this.deps.providerSourceKey(provider) === request.context!.historyRecovery!.sourceKey)
      : undefined);
  }

  private async firstBrokerResult<T>(
    candidates: BrokerCandidate[],
    fetch: (candidate: BrokerCandidate) => Promise<T | null>,
    coverage?: { isUsable(value: T): boolean; merge(value: T, unavailable: T[]): T },
  ): Promise<SourceResult<T> | null> {
    const unavailable: T[] = [];
    let firstUnavailable: SourceResult<T> | null = null;
    for (const candidate of candidates) {
      try {
        const value = await fetch(candidate);
        if (value !== null) {
          const result = { sourceKey: this.deps.brokerSourceKey(candidate), value };
          if (coverage && !coverage.isUsable(value)) { unavailable.push(value); firstUnavailable ??= result; continue; }
          return coverage ? { ...result, value: coverage.merge(value, unavailable) } : result;
        }
      } catch {
        // Continue through the broker candidates.
      }
    }
    return firstUnavailable && coverage
      ? { ...firstUnavailable, value: coverage.merge(firstUnavailable.value, unavailable) } : firstUnavailable;
  }

  private async firstProviderResult<T>(
    fetch: (provider: DataProvider) => Promise<T | null>,
    coverage?: { isUsable(value: T): boolean; merge(value: T, unavailable: Array<T>): T },
    scopedProviders?: DataProvider[],
  ): Promise<SourceResult<T> | null> {
    const unavailable: Array<T> = [];
    const usable = coverage?.isUsable ?? ((value: T) => Array.isArray(value) && value.length > 0);
    const withUnavailable = (result: SourceResult<T> | null) => result && coverage
      ? { ...result, value: coverage.merge(result.value, unavailable) } : result;
    const providers = scopedProviders ?? this.deps.providersInPriorityOrder();
    let firstEmptyResult: SourceResult<T> | null = null;
    let coverageError: HistoryCoverageError | null = null;
    const tryProvider = async (provider: DataProvider): Promise<SourceResult<T> | null> => {
      try {
        const value = await fetch(provider);
        if (value === null) return null;
        const result = { sourceKey: this.deps.providerSourceKey(provider), value };
        if (!usable(value)) { unavailable.push(value); firstEmptyResult ??= result; }
        return result;
      } catch (error) {
        if (error instanceof HistoryCoverageError) coverageError ??= error;
        if (!isHistoryRetentionError(error) && shouldLogProviderError(error)) {
          this.deps.logProviderError(`${provider.id} failed: ${error}`);
        }
        return null;
      }
    };

    if (providers.length <= 1) {
      for (const provider of providers) {
        const result = await tryProvider(provider);
        if (result && usable(result.value)) return withUnavailable(result);
      }
      if (coverageError) throw coverageError;
      return withUnavailable(firstEmptyResult);
    }

    const preferred = tryProvider(providers[0]!);
    const speculativeDelay = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), 200);
    });
    const first = await Promise.race([preferred, speculativeDelay]);
    if (first !== "timeout" && first && usable(first.value)) return withUnavailable(first);

    const remaining = providers.slice(1).map((provider) => tryProvider(provider));
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (result: SourceResult<T> | null) => {
        if (settled || !result || !usable(result.value)) return;
        settled = true;
        resolve(withUnavailable(result));
      };
      void preferred.then((result) => {
        if (result && usable(result.value)) finish(result);
      });
      for (const pending of remaining) {
        void pending.then(finish);
      }
      void Promise.all([preferred, ...remaining]).then(() => {
        if (!settled) {
          if (coverageError) reject(coverageError);
          else resolve(withUnavailable(firstEmptyResult));
        }
      });
    });
  }
}
