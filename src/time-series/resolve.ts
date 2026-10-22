import { logFailure } from "../utils/log-failure";
import { hasValidQuoteObservationTime } from "../market-data/quotes/freshness";
import { delistingLabel } from "../market-data/quotes/delisting";
import { financialPeriodCoverage, financialPeriodCoverageWarnings, limitSeriesObservations } from "./financial-period-coverage";
import { historyCoverageNotice } from "../sources/history-coverage";
import { historyRetentionNotice, historyStartNotice } from "../sources/history-retention";
import type { BrokerContractRef } from "../types/instrument";
import { FINANCIAL_VINTAGE_NOTICE, SEC_EPS_BASIS_NOTICE } from "../utils/financial-statements";
import { subtractTimeRange } from "./date-window";
import {
  CHART_RESOLUTION_STEP_MS,
  clampTimeRangeToMaxRange,
  DEFAULT_CHART_RESOLUTION_SUPPORT,
  getSupportMaxRange,
  intersectChartResolutionSupport,
  isIntradayResolution,
  normalizeChartResolutionSupport,
  type ChartResolutionSupport,
  type ManualChartResolution,
} from "./resolution";
import { TIME_RANGES, type TimeRange } from "./range";
import type { DataProvider } from "../types/data-provider";
import type { Quote, TickerFinancials } from "../types/financials";
import { mergeQuoteMetadata, quoteMetadataFromQuote, quoteMetadataMatchesTarget } from "../market-data/quotes/metadata";
import type { FredSeriesRequest } from "../sources/gloomberb-cloud/fred-series";
import { fredCreditCoverageNotice } from "./economic";
import {
  getTimeSeriesField,
  isFundamentalFieldId,
  isMarketFieldId,
  isPriceOnlyMarketFieldId,
} from "./field-catalog";
import {
  fundamentalSeriesUsesAvailabilityFallback,
  valuationSeriesUsesLiveQuote,
  valuationSeriesUsesPriceHistory,
} from "./fundamentals";
import { FORWARD_PE_BASIS_NOTICE, REALIZED_NTM_PE_BASIS_NOTICE } from "./forward-valuation";
import { valuationPriceWarning } from "./valuation-price";
import { VALUATION_CURRENCY_WARNING_PREFIX } from "./valuation-currency";
import { chartPriceHistoryIntegrityNotices } from "./market";
import { maxStudyWarmupPoints, resolveStudies } from "./studies";
import { clipSeriesToWindow } from "./alignment";
import {
  bufferPriceComparison,
  clipPriceComparison,
  priceComparisonBoundsForSeries,
  priceComparisonSeriesIds,
  resolvePriceComparison,
} from "./price-comparison";
import { chartQuoteOverrideKeyForSource } from "./live-quotes";
import { chartSeriesSourceKey } from "../capabilities/chart-series";
import { rememberSeedListingFacts } from "./parsed-history-cache";
import {
  canonicalExchange,
  isUsListingExchange,
  parsePublicTickerKey,
} from "../utils/exchanges";
import { isPriceHistoryStaleForCurrentWindow } from "../utils/price-history";
import { listingTimeZone } from "../market-data/market/trading-sessions";
import { futuresGenericListing, futuresListingPriceBasis } from "../utils/futures-generic";
import { classifyInstrumentType, kindFromListingSyntax } from "../tickers/instrument-kind";
import { isDatasetChart } from "./spec";
import { seriesMessageName } from "./series-name";
import type {
  ChartResolutionResult,
  ChartSeriesSpec,
  ChartSpec,
  ResolvedSeries,
} from "./types";
import {
  type ChartResolveSources,
  type ChartResolveOptions,
  type LiveTailRequest,
  ChartResolveCache,
  type LoadedPriceHistory,
  requestContext,
  instrumentKey,
  instrumentLabel,
} from "./resolve-context";
import {
  dateOnly,
  explicitBounds,
  rangeDurationBounds,
  requestedBounds,
  runtimeAutoBounds,
  runtimeRequestBounds,
  sameBounds,
  requestResolution,
  calculationBounds,
  barsAhead,
  trailingRangeForStart,
  filterPoints,
  comparisonDisplayBounds,
  followLatestMarketObservation,
  capabilityRequestBounds,
  endAtNewestObservation,
  latestSessionView,
} from "./chart-bounds";
import {
  type PriceHistoryRequest,
  PriceHistoryAcquisitionError,
  priceHistoryAcquisitionIdentity,
  priceHistoryTailAcquisition,
  behindHistoryNotice,
  mergePriceHistoryWindows,
  historyIntersectsBounds,
  clampHistoryBoundsToSupport,
  retainedWarmup,
  loadPriceHistory,
} from "./history-acquisition";
import {
  unloadableSeries,
  emptyFinancials,
  chartCalculationSeriesIds,
  latestQuote,
  mergeHistory,
  baseSecuritySeries,
  baseEconomicSeries,
  baseCapabilitySeries,
  staleFredWarning,
} from "./base-series";
import {
  resolvePriceHistoryIntegrity,
  assignAxes,
  adoptPriceUnits,
  prepareBaseSeriesForStudies,
  presentationBounds,
  applyStudyPresentationTransforms,
} from "./series-presentation";

function withQuoteExchange(
  source: Extract<ChartSeriesSpec["source"], { kind: "security" }>,
  ...quotes: Array<Quote | undefined>
): Extract<ChartSeriesSpec["source"], { kind: "security" }> {
  if (source.instrument.exchange?.trim()) return source;
  const exchange = quotes
    .map((quote) => quote?.listingExchangeName?.trim() || quote?.exchangeName?.trim())
    .find((value): value is string => !!value);
  if (!exchange) return source;
  return {
    ...source,
    instrument: {
      ...source.instrument,
      exchange,
    },
  };
}


function chartIsPriceOnly(spec: ChartSpec, calculationSeriesIds: ReadonlySet<string>): boolean {
  return spec.series.every((entry) => {
    if (!calculationSeriesIds.has(entry.id) || entry.source.kind !== "security") return true;
    return isPriceOnlyMarketFieldId(entry.source.fieldId);
  });
}

/**
 * A US stock or fund listing, including one a broker contract routes through
 * SMART in dollars. Options and futures have no pre-market session.
 */
function tradesUsExtendedHours(exchange: string | undefined, contract: BrokerContractRef | null | undefined): boolean {
  if (contract?.secType && !["STK", "ETF"].includes(contract.secType.toUpperCase())) return false;
  const venue = exchange || contract?.primaryExchange || contract?.exchange;
  return isUsListingExchange(venue) || isUsListingExchange(contract?.primaryExchange)
    || (!!contract && canonicalExchange(venue) === "SMART" && (!contract.currency || contract.currency.toUpperCase() === "USD"));
}

/** Fewer daily or coarser bars than this make a line or two, not a chart. */
const SHORT_HISTORY_MAX_BARS = 20;

/**
 * Auto on a preset range of market series alone, at no authored period and
 * untouched by pan or zoom: the chart that can fall back to the range a young
 * listing has traded.
 */
function canFitShortHistory(spec: ChartSpec, options: ChartResolveOptions): boolean {
  const visible = spec.series.filter((entry) => entry.visible !== false);
  return spec.viewport.resolution === "auto" && spec.viewport.range !== "1D" && !explicitBounds(spec)
    && spec.viewport.maxPoints === undefined && !runtimeAutoBounds(options) && !runtimeRequestBounds(options)
    && visible.length > 0 && visible.every((entry) => entry.source.kind === "security" && isMarketFieldId(entry.source.fieldId)
      && (entry.source.period ?? "auto") === "auto");
}

function visibleMarketBars(result: ChartResolutionResult): { count: number; first: number } {
  let count = 0;
  let first = Number.POSITIVE_INFINITY;
  for (const series of result.series) {
    if (series.observationKind !== "market") continue;
    let bars = 0;
    for (const point of series.points) {
      const time = point.date.getTime();
      if (point.value === null || !Number.isFinite(point.value) || !Number.isFinite(time)) continue;
      bars += 1;
      first = Math.min(first, time);
    }
    count = Math.max(count, bars);
  }
  return { count, first };
}

/** The earliest plotted observation of any series, or +Infinity. */
function firstObservationTime(series: readonly ResolvedSeries[]): number {
  let first = Number.POSITIVE_INFINITY;
  for (const entry of series) {
    for (const point of entry.points) {
      const time = point.date.getTime();
      if (point.value !== null && Number.isFinite(point.value) && Number.isFinite(time) && time < first) first = time;
    }
  }
  return first;
}

/** The shortest preset range that holds an observation at `first`. */
function coveringRange(first: number, now: Date): TimeRange | null {
  return TIME_RANGES.find((range) => range !== "ALL" && subtractTimeRange(now, range).getTime() <= first) ?? null;
}

export async function resolveChartSpecData(
  spec: ChartSpec,
  sources: ChartResolveSources,
  cache = new ChartResolveCache(),
  options: ChartResolveOptions = {},
): Promise<ChartResolutionResult> {
  if (!canFitShortHistory(spec, options)) return resolveChartSpecPass(spec, sources, cache, options);
  // Captured inputs belong to the chart that is returned.
  type Capture = Parameters<NonNullable<ChartResolveSources["onSecurityData"]>>;
  const capturing = (captured: Capture[]): ChartResolveSources => sources.onSecurityData
    ? { ...sources, onSecurityData: (...args) => { captured.push(args); } } : sources;
  const now = sources.now ?? new Date();
  let captured: Capture[] = [];
  let shownSpec = spec;
  let result = await resolveChartSpecPass(spec, capturing(captured), cache, options);
  // A listing younger than the range has a bar or two at weekly or monthly
  // size. When its sources serve finer bars, Auto charts the shortest range
  // that holds them all, at that range's interval. Coarse bars are dated at
  // their period's start, so the finer bars can place the first trade in a
  // shorter range still.
  const coarse = !!result.resolution && !isIntradayResolution(result.resolution)
    && !!result.resolutionSupport?.some((entry) => isIntradayResolution(entry.resolution));
  let shown = coarse ? visibleMarketBars(result) : { count: 0, first: Number.POSITIVE_INFINITY };
  let range = shown.count > 0 && shown.count < SHORT_HISTORY_MAX_BARS ? coveringRange(shown.first, now) : null;
  while (range && TIME_RANGES.indexOf(range) < TIME_RANGES.indexOf(shownSpec.viewport.range)) {
    const liveTails = cache.liveTails;
    const narrowedCaptured: Capture[] = [];
    const narrowedSpec = { ...shownSpec, viewport: { ...shownSpec.viewport, range } };
    const narrowed = await resolveChartSpecPass(narrowedSpec, capturing(narrowedCaptured), cache, options);
    const bars = visibleMarketBars(narrowed);
    if (bars.count <= shown.count) {
      cache.liveTails = liveTails;
      break;
    }
    [shownSpec, result, shown, captured] = [narrowedSpec, narrowed, bars, narrowedCaptured];
    range = coveringRange(bars.first, now);
  }
  // The axis opens at the first trade, as ALL does, not at an empty week.
  if (shownSpec !== spec && result.viewport && shown.first > result.viewport.start.getTime()) {
    result = { ...result, viewport: { start: new Date(shown.first), end: result.viewport.end } };
  }
  for (const args of captured) sources.onSecurityData?.(...args);
  return result;
}

async function resolveChartSpecPass(
  spec: ChartSpec,
  sources: ChartResolveSources,
  cache: ChartResolveCache,
  options: ChartResolveOptions,
): Promise<ChartResolutionResult> {
  const errors: string[] = [];
  const warnings: string[] = spec.series.some((entry) => entry.visible !== false
    && entry.source.kind === "security" && isFundamentalFieldId(entry.source.fieldId))
    ? [FINANCIAL_VINTAGE_NOTICE] : [];
  const priorityWarnings: string[] = [];
  const delistings = new Map<string, { symbol: string; label: string; notice: string }>();
  const baseSeriesIds = new Set(spec.series.map((entry) => entry.id));
  const visibleSeriesIds = new Set(spec.series
    .filter((entry) => entry.visible !== false)
    .map((entry) => entry.id));
  const calculationSeriesIds = chartCalculationSeriesIds(spec);
  const primaryMarketSeries = spec.series.find(entry => entry.source.kind === "security" && isMarketFieldId(entry.source.fieldId));
  if (!sources.dataProvider && spec.series.some((entry) => (
    calculationSeriesIds.has(entry.id) && entry.source.kind === "security"
  ))) {
    return { series: [], loading: false, errors: ["Market data is unavailable."], warnings };
  }

  const resolutionStartedAt = Date.now();
  const referenceNow = sources.now ?? new Date(resolutionStartedAt);
  const liveTails = new Map<string, LiveTailRequest>();
  const comparedSeriesIds = new Set(priceComparisonSeriesIds(spec) ?? []);
  const initialVisibleBounds = requestedBounds(spec, referenceNow);

  const loadFinancials = (source: Extract<ChartSeriesSpec["source"], { kind: "security" }>) => {
    const fieldId = getTimeSeriesField(source.fieldId)?.id ?? source.fieldId;
    // Calendar-window research needs the same full source bundle as a period
    // count. The extended bundle also carries the estimate history behind the
    // forward multiples; PEG alone has no historical series.
    const statementHistory = /^(fundamental|valuation)\./.test(fieldId)
      && fieldId !== "valuation.pegRatio"
      ? "extended" as const : undefined;
    const key = `${instrumentKey(source)}|history:${statementHistory ?? "default"}`;
    let pending = cache.financialsByInstrument.get(key);
    if (!pending) {
      pending = sources.dataProvider!
        .getTickerFinancials(
          source.instrument.symbol,
          source.instrument.exchange ?? "",
          { ...requestContext(source), statementHistory },
        )
        .then((value) => {
          if (value.statementHistory?.status === "retryable-failure") {
            warnings.push(`${source.instrument.symbol}: extended SEC history is temporarily unavailable; retained observations may be from an earlier retrieval.`);
          }
          if (statementHistory && (!value.statementHistory || value.statementHistory.status === "retryable-failure")) cache.financialsByInstrument.delete(key);
          return value;
        })
        .catch((error) => {
          logFailure("time-series-resolve", "Loading chart financials failed")(error);
          cache.financialsByInstrument.delete(key);
          return null;
        });
      cache.financialsByInstrument.set(key, pending);
      cache.revision += 1;
    }
    return pending;
  };
  const loadQuoteMetadata = (source: Extract<ChartSeriesSpec["source"], { kind: "security" }>) => {
    const key = instrumentKey(source);
    let pending = cache.quoteMetadataByInstrument.get(key);
    if (!pending) {
      const provider = sources.dataProvider!;
      pending = Promise.resolve().then(() => provider.getQuoteMetadata
        ? provider.getQuoteMetadata(source.instrument.symbol, source.instrument.exchange ?? "", requestContext(source))
        : provider.getQuote(source.instrument.symbol, source.instrument.exchange ?? "", requestContext(source)).then(quoteMetadataFromQuote))
        .then((metadata) => metadata && quoteMetadataMatchesTarget(metadata, source.instrument.symbol, source.instrument.exchange) ? metadata : null)
        .then((metadata) => { if (!metadata) cache.quoteMetadataByInstrument.delete(key); return metadata; })
        .catch((error) => {
          logFailure("time-series-resolve", "Loading chart quote metadata failed")(error);
          cache.quoteMetadataByInstrument.delete(key);
          return null;
        });
      cache.quoteMetadataByInstrument.set(key, pending);
      cache.revision += 1;
    }
    return pending;
  };
  // True when a price-only chart painted with the placeholder list because the
  // real one had not answered yet. The placeholder must not narrow Auto's
  // choices: it is provider-shaped and omits 1m and 30m that other sources serve.
  let provisionalSupport = false;
  const notifiedSupportKeys = new Set<string>();
  const startResolutionSupport = (
    source: Extract<ChartSeriesSpec["source"], { kind: "security" }>,
  ): Promise<ChartResolutionSupport[]> => {
    const provider = sources.dataProvider!;
    const key = `${provider.id}|${instrumentKey(source)}`;
    let pending = cache.resolutionSupportByInstrument.get(key);
    if (!pending) {
      let result: ReturnType<NonNullable<DataProvider["getChartResolutionSupport"]>>;
      try {
        result = provider.getChartResolutionSupport!(
          source.instrument.symbol,
          source.instrument.exchange ?? "",
          requestContext(source),
        );
      } catch (error) {
        // A synchronous throw is a programming error, not a missing answer;
        // let the resolve fail the way it always has.
        pending = Promise.reject(error);
        cache.resolutionSupportByInstrument.set(key, pending);
        cache.rejectedResolutionSupport.add(key);
        cache.revision += 1;
        return pending;
      }
      if (Array.isArray(result)) {
        const settled = normalizeChartResolutionSupport(result);
        cache.settledResolutionSupport.set(key, settled);
        pending = Promise.resolve(settled);
      } else {
        // An unanswered source narrows nothing: empty support leaves the
        // preset in charge, the same as a source without the capability.
        pending = Promise.resolve(result)
          .then((value) => normalizeChartResolutionSupport(value))
          .catch(logFailure("time-series-resolve", "Could not load chart resolution support", [] as ChartResolutionSupport[]));
        const settledPending = pending;
        settledPending.then((settled) => {
          if (cache.resolutionSupportByInstrument.get(key) !== settledPending) return;
          cache.settledResolutionSupport.set(key, settled);
          cache.revision += 1;
        });
      }
      cache.resolutionSupportByInstrument.set(key, pending);
      cache.revision += 1;
    }
    return pending;
  };
  const loadResolutionSupport = (
    source: Extract<ChartSeriesSpec["source"], { kind: "security" }>,
    immediate: boolean,
  ): Promise<ChartResolutionSupport[]> => {
    const provider = sources.dataProvider!;
    if (!provider.getChartResolutionSupport) return Promise.resolve([]);
    const pending = startResolutionSupport(source);
    if (!immediate || options.awaitResolutionSupport) return pending;
    const key = `${provider.id}|${instrumentKey(source)}`;
    if (cache.rejectedResolutionSupport.has(key)) return pending;
    const settled = cache.settledResolutionSupport.get(key);
    if (settled) return Promise.resolve(settled);
    provisionalSupport = true;
    const notify = options.onResolutionSupportSettled;
    if (notify && !notifiedSupportKeys.has(key)) {
      notifiedSupportKeys.add(key);
      pending.then(() => notify());
    }
    return Promise.resolve(DEFAULT_CHART_RESOLUTION_SUPPORT);
  };
  const sourceWithResolvedExchange = (
    source: Extract<ChartSeriesSpec["source"], { kind: "security" }>,
    financials: TickerFinancials | null,
  ) => {
    const quoteOverride = sources.quoteOverrides?.get(chartQuoteOverrideKeyForSource(source));
    return withQuoteExchange(
      source,
      latestQuote(financials?.quote, quoteOverride),
      financials?.quote,
      quoteOverride,
    );
  };

  const adaptiveBounds = spec.viewport.resolution === "auto"
    ? runtimeAutoBounds(options)
    : null;
  const requestBounds = runtimeRequestBounds(options) ?? adaptiveBounds;
  const activeMarketSources = [...new Map(spec.series.flatMap((entry) => (
    calculationSeriesIds.has(entry.id)
      && entry.source.kind === "security"
      && isMarketFieldId(entry.source.fieldId)
      ? [[instrumentKey(entry.source), entry.source] as const]
      : []
  ))).values()];
  const priceOnly = chartIsPriceOnly(spec, calculationSeriesIds);
  const resolutionSupportSources = await Promise.all(activeMarketSources.map(async (source) => (
    source.instrument.exchange?.trim()
      ? source
      : sourceWithResolvedExchange(source, await loadFinancials(source))
  )));
  const supportBySource = await Promise.all(resolutionSupportSources.map((source) => loadResolutionSupport(source, priceOnly)));
  const sharedSupport = activeMarketSources.length > 0 ? intersectChartResolutionSupport(supportBySource) : [];
  // A placeholder list is not what the source serves; only a real answer seeds the next open.
  if (!provisionalSupport) activeMarketSources.forEach((source, index) => {
    const served = supportBySource[index];
    if (served?.length) rememberSeedListingFacts(source.instrument, { resolutionSupport: served });
  });
  const initialResolution = requestResolution(
    spec,
    initialVisibleBounds,
    calculationSeriesIds,
    options,
    sharedSupport,
    provisionalSupport,
  );
  if (
    spec.viewport.resolution !== "auto"
    && initialResolution !== spec.viewport.resolution
  ) {
    warnings.push(
      `${spec.viewport.resolution.toUpperCase()} data is unavailable for this range. Auto resolution was used instead.`,
    );
  }
  const requestVisibleBounds = requestBounds ?? initialVisibleBounds;
  // A view the user panned or zoomed to, as opposed to authored dates.
  const movedWindow = requestBounds !== null && !sameBounds(requestBounds, initialVisibleBounds);
  const hasExplicitWindow = explicitBounds(spec) !== null || movedWindow;
  const initialCalculationBounds = calculationBounds(spec, requestVisibleBounds, initialResolution);

  // Only US stocks and funds trade before and after the regular session; asking elsewhere costs a request for nothing.
  const extendedHoursFor = (source: Extract<ChartSeriesSpec["source"], { kind: "security" }>, resolution: ManualChartResolution) => (
    spec.viewport.extendedHours === true && isMarketFieldId(source.fieldId) && isIntradayResolution(resolution)
      && tradesUsExtendedHours(source.instrument.exchange, source.instrument.instrument)
  );
  // A history starts after the visible window because its source keeps no more.
  let retainedHistoryOnly = false;
  const loadHistory = async (
    source: Extract<ChartSeriesSpec["source"], { kind: "security" }>,
    all = false,
  ) => {
    const support = await loadResolutionSupport(source, priceOnly);
    const maxRange = getSupportMaxRange(support, initialResolution);
    const ahead = movedWindow ? barsAhead(requestVisibleBounds, maxRange, referenceNow.getTime()) : 0;
    const durationEnd = rangeDurationBounds(spec, initialCalculationBounds).end;
    const historyBounds = clampHistoryBoundsToSupport(
      ahead > 0 && initialCalculationBounds.end !== null
        ? { ...initialCalculationBounds, end: initialCalculationBounds.end + ahead } : initialCalculationBounds,
      maxRange,
      durationEnd === null ? null : durationEnd + ahead,
    );
    const requestedFallbackRange = all
      ? "ALL"
      : trailingRangeForStart(historyBounds.start, referenceNow);
    const fallbackRange = maxRange
      ? clampTimeRangeToMaxRange(requestedFallbackRange, maxRange)
      : requestedFallbackRange;
    const request: PriceHistoryRequest = {
      bounds: historyBounds,
      visibleBounds: requestVisibleBounds,
      explicitWindow: hasExplicitWindow,
      authoredWindow: hasExplicitWindow && !movedWindow,
      fallbackRange,
      resolution: initialResolution,
      allowProviderDefaultFallback: spec.viewport.resolution === "auto",
      support,
      requiredWarmupPoints: maxStudyWarmupPoints(spec.studies),
      ...(extendedHoursFor(source, initialResolution) ? { historySession: "extended" as const } : {}),
    };
    const key = [
      instrumentKey(source),
      request.resolution,
      ...(request.historySession ? [request.historySession] : []),
      request.fallbackRange,
      request.allowProviderDefaultFallback ? "auto" : "manual",
      isMarketFieldId(source.fieldId) ? source.period ?? "auto" : "auto",
      ...(request.explicitWindow
        ? [request.bounds.start ?? "open", request.bounds.end ?? "open"]
        : []),
      // A moved view can chart retained bars that the same authored dates cannot.
      ...(request.explicitWindow && !request.authoredWindow && !request.allowProviderDefaultFallback ? ["moved"] : []),
    ].join("|");
    request.historyRequestKey = key;
    const expiresAt = cache.priceHistoryExpiryByRequest.get(key);
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      cache.priceHistoryByRequest.delete(key);
      cache.priceHistoryExpiryByRequest.delete(key);
    }
    let pending = cache.priceHistoryByRequest.get(key);
    const reused = pending !== undefined;
    const acquire = () => {
      const next = loadPriceHistory(sources.dataProvider!, source, request);
      cache.priceHistoryByRequest.set(key, next);
      cache.revision += 1;
      // Retention expiry is independent of the current session/bar boundary.
      void next.then((value) => {
        if (cache.priceHistoryByRequest.get(key) !== next) return;
        if (value.expiresAt !== undefined) cache.priceHistoryExpiryByRequest.set(key, value.expiresAt);
        else cache.priceHistoryExpiryByRequest.delete(key);
      }, (error: unknown) => {
        if (cache.priceHistoryByRequest.get(key) !== next) return;
        if (error instanceof PriceHistoryAcquisitionError) cache.priceHistoryExpiryByRequest.set(key, error.retryAt);
        else if ((cache.priceHistoryRefreshAfter.get(key) ?? 0) > Date.now()) {
          cache.priceHistoryExpiryByRequest.set(key, cache.priceHistoryRefreshAfter.get(key)!);
        } else cache.priceHistoryByRequest.delete(key);
      });
      return next;
    };
    pending ??= acquire();
    let loaded: LoadedPriceHistory;
    try {
      loaded = await pending;
    } catch (error) {
      // Another series' refetch failed and put the saved copy back below.
      const restored = cache.priceHistoryByRequest.get(key);
      if (!restored || restored === pending) throw error;
      pending = restored;
      loaded = await pending;
    }
    const now = () => referenceNow.getTime() + Math.max(0, Date.now() - resolutionStartedAt);
    const currentWindow = () => !request.explicitWindow
      || (request.bounds.end !== null && now() - (request.bounds.end + 1) < 60 * 60_000);
    // A copy with a session record is judged here; any other says so itself,
    // when the router answered it from a saved copy short of the latest session.
    const staleCurrent = (value: LoadedPriceHistory) => currentWindow() && (value.savedCopyBehind === true
      || (!!value.session && isPriceHistoryStaleForCurrentWindow(value.points, now(), {
        symbol: source.instrument.symbol, exchange: source.instrument.exchange, session: value.session,
        ...(value.resolution ? { intervalMs: CHART_RESOLUTION_STEP_MS[value.resolution] } : {}),
      })));
    // A copy behind the current session is fetched again at most every 30 s.
    // Until a fetch answers a current one, the saved copy is drawn with a
    // notice, as every other history path does, rather than an error.
    let behind = false;
    if (staleCurrent(loaded)) {
      const saved = pending;
      const savedValue = loaded;
      const latest = cache.priceHistoryByRequest.get(key);
      let refresh: Promise<LoadedPriceHistory> | undefined;
      if (reused && (cache.priceHistoryRefreshAfter.get(key) ?? 0) <= Date.now()) {
        // Claim the refresh before awaiting it so price/volume/studies share one attempt.
        cache.priceHistoryRefreshAfter.set(key, Date.now() + 30_000);
        refresh = latest && latest !== pending ? latest : acquire();
      } else if (latest && latest !== pending) {
        refresh = latest;
      }
      if (refresh) {
        const attempt = refresh;
        loaded = await attempt.catch(() => {
          // A failed refetch leaves the saved copy in place until the next one is due.
          if (cache.priceHistoryByRequest.get(key) === attempt) {
            cache.priceHistoryByRequest.set(key, saved);
            if (savedValue.expiresAt !== undefined) cache.priceHistoryExpiryByRequest.set(key, savedValue.expiresAt);
            else cache.priceHistoryExpiryByRequest.delete(key);
          }
          return savedValue;
        });
      }
      behind = staleCurrent(loaded);
      if (behind) {
        const previousDeadline = cache.priceHistoryRefreshAfter.get(key) ?? 0;
        cache.priceHistoryRefreshAfter.set(key, previousDeadline > Date.now() ? previousDeadline : Date.now() + 30_000);
        const notice = behindHistoryNotice(source, loaded.points, now());
        if (notice) priorityWarnings.push(notice);
      }
    }
    if (!behind) cache.priceHistoryRefreshAfter.delete(key);
    const history = loaded.points;
    const coverageNotice = historyCoverageNotice(loaded.coverageStart, request.visibleBounds.start);
    if (coverageNotice) priorityWarnings.push(coverageNotice);
    // A listing that no longer trades is named so beside its bars, which end on its last session.
    if (loaded.delisting) {
      const symbol = parsePublicTickerKey(source.instrument.symbol).symbol;
      const label = delistingLabel(loaded.delisting);
      const notice = `${symbol}: ${label}`;
      priorityWarnings.push(notice);
      if (!delistings.has(notice)) delistings.set(notice, { symbol, label, notice });
    }
    // Read per request: one recovered window answers every visible window that shares its acquisition.
    if (loaded.recovery && request.visibleBounds.start !== null && request.visibleBounds.start < loaded.recovery.start) {
      priorityWarnings.push(historyRetentionNotice(loaded.recovery.retention, loaded.resolution ?? request.resolution,
        listingTimeZone(source.instrument.symbol, source.instrument.exchange)));
      retainedHistoryOnly = true;
    }
    // Only proven equal cadences can share an accumulated observation window.
    // An opaque default result stays attached to its original acquisition.
    const accumulationKey = loaded.resolution === null ? null
      : `${instrumentKey(source)}|${loaded.resolution}|${loaded.extendedHours ? "extended|" : ""}${priceHistoryAcquisitionIdentity(loaded)}`;
    const previous = accumulationKey ? cache.accumulatedPriceHistory.get(accumulationKey) : undefined;
    const previousHistory = previous?.points ?? [];
    if (
      request.explicitWindow
      && !historyIntersectsBounds(history, request.visibleBounds)
      && !historyIntersectsBounds(previousHistory, request.visibleBounds)
    ) {
      throw new Error(
        `Price history for the requested window is unavailable for ${instrumentLabel(source)}.`,
      );
    }
    // Live passes resolve the same load again; merging it again changes nothing.
    const unchanged = previous !== undefined && accumulationKey !== null
      && cache.accumulatedFrom.get(accumulationKey) === loaded;
    let combined: LoadedPriceHistory;
    if (unchanged) {
      combined = previous;
    } else {
      const accumulated = loaded.resolution === null ? history : mergePriceHistoryWindows(
        previousHistory, history, loaded.resolution,
      );
      const tail = priceHistoryTailAcquisition(previous, loaded);
      const historyStart = loaded.historyStart ?? previous?.historyStart;
      combined = { ...loaded, session: tail.session, sourceKey: tail.sourceKey, points: accumulated,
        ...(historyStart !== undefined ? { historyStart } : {}) };
      if (accumulationKey) {
        cache.accumulatedPriceHistory.set(accumulationKey, combined);
        cache.accumulatedFrom.set(accumulationKey, loaded);
        cache.revision += 1;
      }
    }
    const accumulated = combined.points;
    // A source that answered a panned view short, and then had nothing older, starts there.
    if (combined.historyStart !== undefined && !loaded.recovery && !combined.coverageStart && request.visibleBounds.start !== null
      && request.visibleBounds.start < combined.historyStart && combined.resolution) {
      priorityWarnings.push(historyStartNotice(combined.historyStart, combined.resolution,
        listingTimeZone(source.instrument.symbol, source.instrument.exchange), referenceNow.getTime()));
    }
    if (accumulationKey && loaded.resolution && isIntradayResolution(loaded.resolution)
      && isMarketFieldId(source.fieldId) && currentWindow()) {
      liveTails.set(key, { source, resolution: loaded.resolution, accumulationKey,
        ...(request.historySession && loaded.extendedHours ? { historySession: request.historySession } : {}) });
    }
    return { ...combined, requestKey: key, accumulationKey,
      ...(loaded.recovery ? { recovery: { ...loaded.recovery,
        requiredWarmupPoints: request.requiredWarmupPoints,
        usableWarmupPoints: retainedWarmup(accumulated, request.visibleBounds.start),
      } } : {}),
    };
  };

  // What a future's price counts, asked once per symbol beside its history.
  // Index and Treasury futures read in points or 32nds, which their unit already says.
  const loadPriceUnit = (
    source: Extract<ChartSeriesSpec["source"], { kind: "security" }>,
    instrumentType: string | undefined,
  ): Promise<string | null> => {
    const { symbol, exchange } = source.instrument;
    if (!sources.loadFuturesPriceUnit || getTimeSeriesField(source.fieldId)?.unitGroup !== "price" || !isMarketFieldId(source.fieldId)
      || (classifyInstrumentType(instrumentType) !== "future" && kindFromListingSyntax(symbol, exchange) !== "future")
      || futuresListingPriceBasis(symbol, exchange)) return Promise.resolve(null);
    const key = symbol.trim().toUpperCase();
    let pending = cache.futuresPriceUnits.get(key);
    if (!pending) {
      pending = sources.loadFuturesPriceUnit(key).catch(logFailure("time-series-resolve", "Could not load futures price unit", null)).then((unit) => {
        // Terms that did not say are asked again on a later pass, when the source allows.
        if (unit === null) cache.futuresPriceUnits.delete(key);
        else cache.revision += 1;
        return unit;
      });
      cache.futuresPriceUnits.set(key, pending);
    }
    return pending;
  };

  const loadEconomicSeries = (request: FredSeriesRequest) => {
    const key = `${request.seriesId.trim().toUpperCase()}|${request.startDate}|${request.sortOrder}`;
    let pending = cache.fredSeriesByRequest.get(key);
    if (!pending) {
      pending = sources.loadFredSeries(request);
      cache.fredSeriesByRequest.set(key, pending);
      cache.revision += 1;
    }
    return pending;
  };

  // The previous close each listing's quote measures its move from, and when it was quoted.
  const quoteReferences = new Map<string, { close: number; time: number }>();
  // Series whose history came with the pre-market and after-hours bars asked for.
  const extendedHistories = new Set<string>();
  const realizedVolInputs = new Set(spec.studies.filter((study) => study.kind === "realized-vol" && study.visible !== false)
    .flatMap((study) => study.inputSeriesIds));
  const historicalPriceSeries = new Map<string, ResolvedSeries>();
  const loaded = await Promise.all(spec.series.map(async (seriesSpec, index) => {
    if (!calculationSeriesIds.has(seriesSpec.id)) return null;
    try {
      if (seriesSpec.source.kind === "capability") {
        if (!sources.resolveCapabilitySeries) {
          throw new Error(`Chart series capability "${seriesSpec.source.capabilityId}" is unavailable. Enable its plugin or provider.`);
        }
        const capabilityBounds = capabilityRequestBounds(requestVisibleBounds, initialVisibleBounds, movedWindow);
        const capabilityViewport: ChartSpec["viewport"] = {
          ...spec.viewport,
          ...(capabilityBounds.start !== null && capabilityBounds.end !== null
            ? {
                dateWindow: {
                  start: new Date(capabilityBounds.start).toISOString(),
                  end: new Date(capabilityBounds.end).toISOString(),
                },
              }
            : {}),
        };
        const key = chartSeriesSourceKey(seriesSpec.source, capabilityViewport);
        let pending = cache.capabilitySeriesByRequest.get(key);
        if (!pending) {
          pending = sources.resolveCapabilitySeries(seriesSpec.source, capabilityViewport, seriesSpec);
          cache.capabilitySeriesByRequest.set(key, pending);
          cache.revision += 1;
        }
        return baseCapabilitySeries(seriesSpec, await pending, index);
      }
      if (seriesSpec.source.kind === "economic") {
        const request: FredSeriesRequest = {
          seriesId: seriesSpec.source.seriesId,
          startDate: initialCalculationBounds.start === null
            ? "1900-01-01"
            : dateOnly(new Date(initialCalculationBounds.start)),
          sortOrder: "asc",
        };
        const fred = await loadEconomicSeries(request);
        const result = baseEconomicSeries(seriesSpec, fred, index);
        const coverageNotice = fredCreditCoverageNotice(seriesSpec.source.seriesId, fred.data.info,
          requestVisibleBounds.start, fred.data.observations);
        if (result && coverageNotice) priorityWarnings.push(`${result.label}: ${coverageNotice}`);
        const freshnessWarning = staleFredWarning(fred);
        if (result && freshnessWarning) priorityWarnings.push(`${result.label}: ${freshnessWarning}`);
        return result;
      }

      const source = seriesSpec.source;
      const marketField = isMarketFieldId(source.fieldId);
      const quoteDerivedValuation = valuationSeriesUsesLiveQuote(source.fieldId);
      const historyPricedValuation = valuationSeriesUsesPriceHistory(source.fieldId);
      // Forward P/E only prices a history when the bundle carries estimates;
      // otherwise the provider's single figure stands and history is not required.
      const forwardPE = getTimeSeriesField(source.fieldId)?.id === "valuation.forwardPE";
      const needsHistory = marketField || (historyPricedValuation && !forwardPE);
      const needsFinancials = !isPriceOnlyMarketFieldId(source.fieldId)
        || !source.instrument.exchange?.trim();
      const financialsPromise = needsFinancials ? loadFinancials(source) : Promise.resolve(null);
      // A continuous future (HO=F) is known by its symbol: its terms load beside its history.
      void loadPriceUnit(source, undefined);
      let resolvedSource = source;
      let financials: TickerFinancials | null;
      let history: LoadedPriceHistory | null;
      if (needsHistory && !source.instrument.exchange?.trim()) {
        financials = await financialsPromise;
        resolvedSource = sourceWithResolvedExchange(source, financials);
        history = await loadHistory(resolvedSource, historyPricedValuation);
      } else {
        [financials, history] = await Promise.all([
          financialsPromise,
          needsHistory ? loadHistory(source, historyPricedValuation) : Promise.resolve(null),
        ]);
        resolvedSource = sourceWithResolvedExchange(source, financials);
      }
      if (history?.extendedHours) extendedHistories.add(seriesSpec.id);
      else if (history && marketField && seriesSpec.visible !== false && extendedHoursFor(resolvedSource, initialResolution)) {
        warnings.push(`${instrumentLabel(resolvedSource)}: pre-market and after-hours bars are unavailable; the chart shows the regular session.`);
      }
      if (forwardPE && financials?.epsEstimates && !history) {
        history = await loadHistory(resolvedSource, true).catch((error: unknown) => {
          warnings.push(`${seriesMessageName(seriesSpec)}: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        });
      }
      // A provider's forward P/E snapshot keeps its own timestamp; only a series
      // that prices today's consensus itself follows the live quote.
      const followsLiveQuote = marketField
        || (quoteDerivedValuation && (!forwardPE || !!financials?.epsEstimates));
      const quoteOverride = followsLiveQuote
        ? sources.quoteOverrides?.get(chartQuoteOverrideKeyForSource(source))
        : undefined;
      // Display style does not change the sampling interval: line and candle
      // charts must merge a live quote into the same active price bar.
      const liveBarResolution = history?.resolution;
      // The viewport's initial reference stays fixed while a source request
      // runs. Validate a newly arrived quote against the elapsed clock.
      const observationNow = referenceNow.getTime() + Math.max(0, Date.now() - resolutionStartedAt);
      let merged = financials ?? (history ? emptyFinancials() : null);
      if (merged && quoteOverride) merged = { ...merged, quote: latestQuote(merged.quote, quoteOverride) };
      if (!merged) throw new Error(`No financial data is available for ${instrumentLabel(source)}.`);
      // Historical labels can retain listing facts after the live price is
      // unavailable. Reuse existing facts before requesting a price-free snapshot.
      const existingMetadata = merged.quoteMetadata && quoteMetadataMatchesTarget(merged.quoteMetadata, resolvedSource.instrument.symbol, resolvedSource.instrument.exchange)
        ? merged.quoteMetadata : undefined;
      const needsMetadata = marketField && (
        !(merged.quote?.currency || existingMetadata?.currency)
        || !(merged.quote?.instrumentType || existingMetadata?.instrumentType)
      );
      const quoteMetadata = mergeQuoteMetadata(existingMetadata, needsMetadata ? await loadQuoteMetadata(resolvedSource) : null);
      if (quoteMetadata || merged.quoteMetadata) merged = { ...merged, quoteMetadata };
      const contractUnit = await loadPriceUnit(resolvedSource, merged.quote?.instrumentType || quoteMetadata?.instrumentType);
      if (marketField) {
        // Same precedence as baseSecuritySeries: the quote's own facts first.
        const listingFacts = mergeQuoteMetadata(merged.quote ? quoteMetadataFromQuote(merged.quote) : undefined, quoteMetadata);
        if (listingFacts?.currency || listingFacts?.instrumentType) rememberSeedListingFacts(source.instrument, { quoteMetadata: listingFacts });
        if (contractUnit) rememberSeedListingFacts(source.instrument, { contractUnit });
      }
      if (history) {
        // Classification must be available before combining observations. A
        // quote cannot establish the price basis of independent bond history.
        // Comparison endpoints also retain source history: a streamed quote
        // could otherwise update only one leg within a shared weekly bar.
        merged = { ...mergeHistory(merged, history.points, undefined, observationNow,
          liveBarResolution ?? undefined, resolvedSource.instrument.exchange,
          liveBarResolution != null && !comparedSeriesIds.has(seriesSpec.id), resolvedSource.instrument.instrument?.secType,
          marketField && history.accumulationKey
            ? { bars: cache.liveBarsFor(history.accumulationKey), since: sources.liveSince, session: history.session,
              extendedHours: history.extendedHours === true }
            : undefined),
          priceHistoryResolution: history.resolution, priceHistoryRequestKey: history.requestKey,
          priceHistorySession: history.session, priceHistorySourceKey: history.sourceKey };
      }
      if ((source.fieldId === "fundamental.eps" || source.fieldId === "valuation.trailingPE")
        && [...merged.annualStatements, ...merged.quarterlyStatements].some((row) => row.epsBasis)) {
        warnings.push(SEC_EPS_BASIS_NOTICE);
      }
      const resolvedSpec = resolvedSource === source ? seriesSpec : { ...seriesSpec, source: resolvedSource };
      // Keep provider history separate from quote-extended display bars. A live
      // mark is not a daily closing observation, including on snapshot replay.
      const historical = history ? { ...merged, priceHistory: history.points } : merged;
      sources.onSecurityData?.(resolvedSpec, history?.session || realizedVolInputs.has(seriesSpec.id) ? historical : merged, history !== null);
      const result = baseSecuritySeries(
        resolvedSpec,
        merged,
        index,
        history?.resolution,
        quoteMetadata,
        contractUnit,
      );
      if (!result) throw new Error(`Unknown field ${source.fieldId}.`);
      if (marketField && history?.historyStart !== undefined && Number.isFinite(history.historyStart)) {
        result.historyStart = new Date(history.historyStart);
      }
      const reference = merged.quote;
      // A rolled generic's previous session can be another contract; its bars carry the roll.
      if (marketField && reference && hasValidQuoteObservationTime(reference) && reference.previousClose !== undefined
        && Number.isFinite(reference.previousClose) && reference.previousClose > 0
        && !futuresGenericListing(resolvedSource.instrument.symbol, resolvedSource.instrument.exchange)) {
        quoteReferences.set(seriesSpec.id, { close: reference.previousClose, time: reference.lastUpdated });
      }
      if (realizedVolInputs.has(seriesSpec.id)) {
        const historicalResult = baseSecuritySeries(resolvedSpec, historical, index, history?.resolution, quoteMetadata, contractUnit);
        if (historicalResult) historicalPriceSeries.set(seriesSpec.id, historicalResult);
      }
      const reportedForwardPE = merged.fundamentals?.forwardPE;
      if (source.fieldId === "valuation.forwardPE" && merged.epsEstimates) {
        warnings.push(FORWARD_PE_BASIS_NOTICE);
      } else if (source.fieldId === "valuation.forwardPE" && reportedForwardPE != null
        && Number.isFinite(reportedForwardPE) && reportedForwardPE <= 0) {
        result.warning = [result.warning, "Reported forward P/E is non-positive and is not meaningful for valuation."].filter(Boolean).join(" ");
      }
      if (source.fieldId === "valuation.realizedNtmPE" && merged.epsEstimates) {
        warnings.push(REALIZED_NTM_PE_BASIS_NOTICE);
      }
      if (isFundamentalFieldId(source.fieldId) && fundamentalSeriesUsesAvailabilityFallback(merged, source)) {
        result.warning = [result.warning, "Publication dates are unavailable for some observations; period-end dates are used as a fallback."].filter(Boolean).join(" ");
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${seriesMessageName(seriesSpec)}: ${message}`);
      return unloadableSeries(seriesSpec, index, message);
    }
  }));

  const rawSeries = loaded.filter((entry): entry is ResolvedSeries => !!entry);
  const marketTimelineSeries = primaryMarketSeries?.visible === false
    ? rawSeries.filter((entry) => entry.id === primaryMarketSeries.id)
    : [];
  // Preset ranges normally end at the requested reference time. A quote fetched
  // asynchronously can be timestamped just after that reference, so advance an
  // untouched market viewport by the same amount instead of clipping its tail.
  // Explicit and user-created windows stay fixed through hasExplicitWindow.
  const primaryRaw = primaryMarketSeries ? rawSeries.find((entry) => entry.id === primaryMarketSeries.id) : undefined;
  // A panned day keeps its reference line; an authored date window has no latest session.
  const sessionView = spec.viewport.range === "1D" && !explicitBounds(spec)
    ? latestSessionView(primaryRaw, rawSeries.filter((entry) => entry.observationKind === "market"),
      extendedHistories.has(primaryRaw?.id ?? ""), quoteReferences.get(primaryRaw?.id ?? ""))
    : null;
  const bounds = hasExplicitWindow
    ? requestVisibleBounds
    : sessionView?.bounds ?? (isDatasetChart(spec)
      ? endAtNewestObservation(initialVisibleBounds, rawSeries)
      : followLatestMarketObservation(initialVisibleBounds, rawSeries));
  if (sessionView?.priorClose != null && primaryRaw?.transform === "raw"
    && primaryRaw.unitGroup.startsWith("price") && primaryRaw.unitGroup !== "price:unknown") {
    const index = rawSeries.indexOf(primaryRaw);
    rawSeries[index] = { ...primaryRaw, priorClose: sessionView.priorClose };
  }
  const servedCadences = new Set(rawSeries.filter((entry) => entry.observationKind === "market" && entry.points.length > 0)
    .map((entry) => entry.historyResolution));
  const commonCadence = servedCadences.size === 1 ? [...servedCadences][0] : undefined;
  const resolution = commonCadence ?? undefined;
  const comparisonResolution = resolution ?? "auto";
  const priceComparison = resolvePriceComparison(spec, rawSeries, bounds, comparisonResolution, requestBounds ? null : spec.viewport.dateWindow,
    { preset: hasExplicitWindow ? null : spec.viewport.range, now: referenceNow.getTime() + Math.max(0, Date.now() - resolutionStartedAt) });
  const displayBounds = comparisonDisplayBounds(bounds, priceComparison);
  const comparisonBounds = priceComparison && priceComparison.start !== null
    ? priceComparison : bounds;
  const baseSeries = rawSeries
    .filter((entry) => visibleSeriesIds.has(entry.id))
    .map((entry) => prepareBaseSeriesForStudies(entry, priceComparisonBoundsForSeries(entry, priceComparison) ?? comparisonBounds, false, priceComparison ? undefined : requestVisibleBounds));
  // Studies run over the same loaded history their base series carries. Clipping
  // them to the requested window instead left a study with no observations
  // wherever the accumulated buffer had already been panned past, so a study's
  // panel emptied out mid-pan and only refilled once the next fetch landed.
  const calculationSeries = rawSeries;
  let resolved = baseSeries;

  // Study outputs are appended by the pure engine before the final viewport clip.
  if (spec.studies.length > 0) {
    const studyResult = resolveStudies(calculationSeries, spec.studies, resolution, historicalPriceSeries);
    resolved = [
      ...resolved,
      ...applyStudyPresentationTransforms(
        studyResult.series,
        spec.studies,
        rawSeries,
        comparisonBounds,
        priceComparison ? undefined : requestVisibleBounds,
        priceComparison,
        bounds,
      ),
    ];
    warnings.push(...studyResult.warnings);
    errors.push(...studyResult.errors);
  }

  const bufferedSeries = assignAxes(adoptPriceUnits(resolved, spec.series), [...spec.series, ...spec.studies], warnings)
    .map((entry) => bufferPriceComparison(entry, priceComparison, bounds));
  resolved = bufferedSeries.map((entry) => {
    const entryBounds = presentationBounds(entry, spec.studies, priceComparison, bounds);
    return entryBounds.start !== null && entryBounds.end !== null
      ? clipSeriesToWindow(entry, new Date(entryBounds.start), new Date(entryBounds.end))
      : { ...entry, points: filterPoints(entry.points, entryBounds) };
  });
  resolved = resolved.map((entry) => limitSeriesObservations(spec, entry));
  resolved = resolved.map((entry) => clipPriceComparison(entry, priceComparison));
  resolved = resolved.map((entry) => {
    const visibleIssues = entry.points.flatMap((point) => point.provenance?.valuationPriceIssues ?? []);
    if (!entry.valuationPriceIssues?.length && !visibleIssues.length) return entry;
    const dates = new Set(entry.points.map((point) => point.date.getTime()));
    const requestedIssues = (entry.valuationPriceIssues ?? []).filter((issue) => {
      const time = issue.affectedAt ? Date.parse(issue.affectedAt) : NaN;
      if (issue.kind === "history") return dates.has(time);
      // Explicit financial-period requests exclude Current observations entirely.
      if (spec.viewport.maxPoints !== undefined) return false;
      if (!Number.isFinite(time)) return !hasExplicitWindow || bounds.end === null || bounds.end >= referenceNow.getTime();
      return (bounds.start === null || time >= bounds.start) && (bounds.end === null || time <= bounds.end);
    });
    const issues = [...new Map([...requestedIssues, ...visibleIssues].map((issue) => [JSON.stringify(issue), issue])).values()];
    return { ...entry, valuationPriceIssues: issues.length ? issues : undefined,
      warning: [entry.warning, valuationPriceWarning(issues)].filter(Boolean).join(" ") || undefined };
  });
  const priceHistoryIntegrity = resolvePriceHistoryIntegrity(
    spec, rawSeries, resolved,
    bounds, comparisonResolution, requestBounds ? null : spec.viewport.dateWindow ?? null,
  );
  if (priceComparison) warnings.push(priceComparison.notice);
  warnings.push(...chartPriceHistoryIntegrityNotices(priceHistoryIntegrity));
  warnings.push(...financialPeriodCoverageWarnings(financialPeriodCoverage(spec, resolved)));
  const resolvedById = new Map(resolved.map((entry) => [entry.id, entry] as const));
  const hiddenBaseSeries = rawSeries
    .filter((entry) => !visibleSeriesIds.has(entry.id))
    .map((entry) => prepareBaseSeriesForStudies(entry, bounds, true, requestVisibleBounds));
  const hiddenBaseById = new Map(hiddenBaseSeries.map((entry) => [entry.id, entry] as const));
  const legendSeries = [
    ...spec.series.flatMap((seriesSpec) => {
      const entry = resolvedById.get(seriesSpec.id) ?? hiddenBaseById.get(seriesSpec.id);
      return entry ? [entry] : [];
    }),
    ...resolved.filter((entry) => !baseSeriesIds.has(entry.id)),
  ];
  for (const entry of resolved) {
    if (entry.warning) warnings.push(`${entry.label}: ${entry.warning}`);
    if (entry.points.length === 0 && entry.unreportedPeriod) {
      warnings.push(`${entry.label}: no ${entry.unreportedPeriod} figures are reported; annual figures are available.`);
    } else if (entry.points.length === 0 && !entry.warning?.startsWith(VALUATION_CURRENCY_WARNING_PREFIX)) {
      // A currency mismatch already explains an empty valuation series.
      warnings.push(`${entry.label}: no observations in the selected date range.`);
    }
  }
  for (const panel of spec.panels) {
    if (panel.scale !== "log") continue;
    const hiddenCount = resolved
      .filter((entry) => entry.panelId === panel.id)
      .flatMap((entry) => entry.points)
      .filter((point) => typeof point.value === "number" && Number.isFinite(point.value) && point.value <= 0)
      .length;
    if (hiddenCount > 0) {
      warnings.push(`${panel.label ?? panel.id}: ${hiddenCount} non-positive observation${hiddenCount === 1 ? " is" : "s are"} hidden on the logarithmic scale.`);
    }
  }

  cache.liveTails = liveTails;
  const exposeViewport = hasExplicitWindow || spec.viewport.maxPoints === undefined;
  let viewport = exposeViewport && displayBounds.start !== null && displayBounds.end !== null
    ? { start: new Date(displayBounds.start), end: new Date(displayBounds.end) }
    : undefined;
  // The axis opens at the first retained bar, as a young listing's does, not
  // at an empty stretch the source no longer keeps.
  if (viewport && retainedHistoryOnly && !hasExplicitWindow) {
    const first = firstObservationTime(resolved);
    if (first > viewport.start.getTime() && first <= viewport.end.getTime()) viewport = { start: new Date(first), end: viewport.end };
  }
  return {
    series: resolved,
    ...(priceHistoryIntegrity.length ? { priceHistoryIntegrity } : {}),
    ...(priceComparison ? { priceComparison } : {}),
    ...(sharedSupport.length > 0 ? { resolutionSupport: sharedSupport } : {}),
    legendSeries,
    ...(spec.viewport.maxPoints === undefined ? { bufferedSeries } : {}),
    ...(marketTimelineSeries.length > 0 ? { timelineSeries: marketTimelineSeries } : {}),
    loading: false,
    errors,
    warnings: [...new Set([...priorityWarnings, ...warnings])],
    ...(delistings.size ? { delistings: [...delistings.values()] } : {}),
    viewport,
    resolution,
  };
}
