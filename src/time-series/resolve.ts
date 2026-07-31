import { appendLiveQuotePoint } from "./chart-data";
import {
  getTimeRangeForDateWindow,
  isDateWindowWithinTimeRange,
  subtractTimeRange,
} from "./date-window";
import {
  CHART_RESOLUTION_STEP_MS,
  clampTimeRangeToMaxRange,
  getBestSupportedResolutionForVisibleWindow,
  getNextBufferRange,
  getPresetResolution,
  getSupportMaxRange,
  intersectChartResolutionSupport,
  TIME_RANGE_ORDER,
  type ChartResolutionSupport,
  type ManualChartResolution,
} from "./resolution";
import type { TimeRange } from "./range";
import type { DataProvider, MarketDataRequestContext } from "../types/data-provider";
import type { Quote, TickerFinancials } from "../types/financials";
import type { FredSeriesLoadResult, FredSeriesRequest } from "../data/fred-series";
import { extractFredSeries } from "./economic";
import {
  getTimeSeriesField,
  isFundamentalFieldId,
  isMarketFieldId,
} from "./field-catalog";
import {
  fundamentalSeriesUsesAvailabilityFallback,
  valuationSeriesUsesLiveQuote,
} from "./fundamentals";
import { extractSecuritySeries } from "./market";
import {
  activeStudyInputSeriesIds,
  maxStudyWarmupPoints,
  resolveStudies,
} from "./studies";
import { isOhlcSeriesStyle } from "./spec";
import { applyResolvedSeriesTransform } from "./transforms";
import { clipSeriesToWindow } from "./alignment";
import { chartQuoteOverrideKeyForSource } from "./live-quotes";
import { resolutionForExplicitMarketPeriods } from "./market-resolution";
import {
  canonicalExchange,
  publicTickerKey,
  resolveExchangeTimeZone,
} from "../utils/exchanges";
import { getPricePointTimestamp } from "../utils/price-history";
import type {
  ChartResolutionResult,
  ChartSeriesSpec,
  ChartSpec,
  ResolvedSeries,
  TimeSeriesPoint,
} from "./types";

const SERIES_COLORS = [
  "#4dabf7",
  "#63e6be",
  "#f6c85f",
  "#b197fc",
  "#ff8787",
  "#ffa94d",
  "#74c0fc",
  "#e599f7",
  "#8ce99a",
  "#ffd43b",
] as const;

export interface ChartResolveSources {
  dataProvider: DataProvider | null;
  loadFredSeries: (request: FredSeriesRequest) => Promise<FredSeriesLoadResult>;
  now?: Date;
  /** Latest streamed quote per security identity, layered over snapshot data. */
  quoteOverrides?: ReadonlyMap<string, Quote>;
}

export interface ChartResolveOptions {
  /** Runtime zoom window used only to choose an adaptive Auto resolution. */
  autoViewport?: { start: Date; end: Date } | null;
  /** Runtime interaction window used to load history around the visible chart. */
  requestViewport?: { start: Date; end: Date } | null;
  /** Approximate number of horizontal observations the current surface can use. */
  targetPointCount?: number;
}

/** Raw source data retained while live quotes recompute the chart tail. */
export class ChartResolveCache {
  readonly financialsByInstrument = new Map<string, Promise<TickerFinancials | null>>();
  readonly priceHistoryByRequest = new Map<string, Promise<TickerFinancials["priceHistory"]>>();
  readonly accumulatedPriceHistory = new Map<string, TickerFinancials["priceHistory"]>();
  readonly resolutionSupportByInstrument = new Map<string, Promise<ChartResolutionSupport[]>>();
  readonly fredSeriesByRequest = new Map<string, Promise<FredSeriesLoadResult>>();
}

interface DateBounds {
  start: number | null;
  /** Inclusive upper bound. */
  end: number | null;
}

interface PriceHistoryRequest {
  bounds: DateBounds;
  visibleBounds: DateBounds;
  explicitWindow: boolean;
  fallbackRange: TimeRange;
  resolution: ManualChartResolution;
  allowProviderDefaultFallback: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function requestContext(spec: Extract<ChartSeriesSpec["source"], { kind: "security" }>): MarketDataRequestContext {
  return {
    brokerId: spec.instrument.brokerId,
    brokerInstanceId: spec.instrument.brokerInstanceId,
    instrument: spec.instrument.instrument ?? null,
  };
}

function instrumentKey(spec: Extract<ChartSeriesSpec["source"], { kind: "security" }>): string {
  return chartQuoteOverrideKeyForSource(spec);
}

function instrumentLabel(spec: Extract<ChartSeriesSpec["source"], { kind: "security" }>): string {
  return publicTickerKey(spec.instrument.symbol, spec.instrument.exchange);
}

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

function finiteDate(value: string | Date | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? new Date(value) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function inclusiveEndDate(value: string | Date | undefined): Date | null {
  const parsed = finiteDate(value);
  if (!parsed) return null;
  return typeof value === "string" && DATE_ONLY_PATTERN.test(value.trim())
    ? new Date(parsed.getTime() + DAY_MS - 1)
    : parsed;
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function explicitBounds(spec: ChartSpec): DateBounds | null {
  const explicitStart = finiteDate(spec.viewport.dateWindow?.start);
  const explicitEnd = inclusiveEndDate(spec.viewport.dateWindow?.end);
  if (!explicitStart || !explicitEnd || explicitStart.getTime() > explicitEnd.getTime()) return null;
  return { start: explicitStart.getTime(), end: explicitEnd.getTime() };
}

function requestedBounds(spec: ChartSpec, latestObservation: Date): DateBounds {
  const explicit = explicitBounds(spec);
  if (explicit) return explicit;
  return {
    start: spec.viewport.range === "ALL"
      ? null
      : subtractTimeRange(latestObservation, spec.viewport.range).getTime(),
    end: latestObservation.getTime(),
  };
}

function runtimeAutoBounds(options: ChartResolveOptions): DateBounds | null {
  const start = options.autoViewport?.start.getTime();
  const end = options.autoViewport?.end.getTime();
  return typeof start === "number"
      && Number.isFinite(start)
      && typeof end === "number"
      && Number.isFinite(end)
      && start <= end
    ? { start, end }
    : null;
}

function runtimeRequestBounds(options: ChartResolveOptions): DateBounds | null {
  const start = options.requestViewport?.start.getTime();
  const end = options.requestViewport?.end.getTime();
  return typeof start === "number"
      && Number.isFinite(start)
      && typeof end === "number"
      && Number.isFinite(end)
      && start <= end
    ? { start, end }
    : null;
}

function sameBounds(left: DateBounds | null, right: DateBounds | null): boolean {
  return left?.start === right?.start && left?.end === right?.end;
}

function boundsRange(bounds: DateBounds): TimeRange {
  if (bounds.start === null || bounds.end === null) return "ALL";
  return getTimeRangeForDateWindow({
    start: new Date(bounds.start),
    end: new Date(bounds.end),
  });
}

function requestResolution(
  spec: ChartSpec,
  bounds: DateBounds,
  calculationSeriesIds: ReadonlySet<string>,
  options: ChartResolveOptions,
  sharedSupport: readonly ChartResolutionSupport[],
): ManualChartResolution {
  if (spec.viewport.resolution !== "auto") {
    const maxRange = getSupportMaxRange(sharedSupport, spec.viewport.resolution);
    const supported = sharedSupport.length === 0
      || (
        maxRange !== null
        && bounds.start !== null
        && bounds.end !== null
        && isDateWindowWithinTimeRange(
          new Date(bounds.start),
          new Date(bounds.end),
          maxRange,
        )
      );
    if (supported) return spec.viewport.resolution;
  }
  const runtimeBounds = runtimeAutoBounds(options);
  const adaptive = runtimeBounds && runtimeBounds.start !== null && runtimeBounds.end !== null
    ? getBestSupportedResolutionForVisibleWindow(
        { start: new Date(runtimeBounds.start), end: new Date(runtimeBounds.end) },
        sharedSupport,
        options.targetPointCount ?? 120,
      )
    : null;
  const preferred = adaptive
    ?? getPresetResolution(explicitBounds(spec) ? boundsRange(bounds) : spec.viewport.range);
  const activeSeries = spec.series.filter((entry) => calculationSeriesIds.has(entry.id));
  return resolutionForExplicitMarketPeriods(preferred, activeSeries);
}

function calculationBounds(
  spec: ChartSpec,
  visibleBounds: DateBounds,
  resolution: ManualChartResolution,
): DateBounds {
  if (visibleBounds.start === null) return visibleBounds;
  const warmupPoints = maxStudyWarmupPoints(spec.studies);

  const visibleEnd = visibleBounds.end ?? visibleBounds.start;
  const bufferedRange = getNextBufferRange(boundsRange(visibleBounds));
  let start = bufferedRange === "ALL"
    ? subtractTimeRange(new Date(visibleEnd), "ALL").getTime()
    : subtractTimeRange(new Date(visibleEnd), bufferedRange).getTime();

  if (warmupPoints > 0) {
    // Calendar gaps and closed sessions mean N observations often span more
    // than N nominal bars. The doubled point window is a bounded safety margin.
    const pointWarmup = warmupPoints * CHART_RESOLUTION_STEP_MS[resolution] * 2;
    start = Math.min(start, visibleBounds.start - pointWarmup);
  }
  return { start: Math.min(start, visibleBounds.start), end: visibleBounds.end };
}

function trailingRangeForStart(start: number | null, referenceDate: Date): TimeRange {
  if (start === null) return "ALL";
  for (const range of TIME_RANGE_ORDER) {
    if (range === "ALL" || start >= subtractTimeRange(referenceDate, range).getTime()) return range;
  }
  return "ALL";
}

function exclusiveEnd(bounds: DateBounds): Date | null {
  return bounds.end === null ? null : new Date(bounds.end + 1);
}

function filterPoints(points: readonly TimeSeriesPoint[], bounds: DateBounds): TimeSeriesPoint[] {
  return points.filter((point) => {
    const time = point.date.getTime();
    return Number.isFinite(time)
      && (bounds.start === null || time >= bounds.start)
      && (bounds.end === null || time <= bounds.end);
  });
}

function emptyFinancials(priceHistory: TickerFinancials["priceHistory"] = []): TickerFinancials {
  return { annualStatements: [], quarterlyStatements: [], priceHistory };
}

function mergePriceHistoryWindows(
  current: TickerFinancials["priceHistory"],
  incoming: TickerFinancials["priceHistory"],
): TickerFinancials["priceHistory"] {
  const byTimestamp = new Map<number, TickerFinancials["priceHistory"][number]>();
  for (const point of [...current, ...incoming]) {
    const timestamp = getPricePointTimestamp(point);
    if (Number.isFinite(timestamp)) {
      byTimestamp.set(
        timestamp,
        point.date instanceof Date ? point : { ...point, date: new Date(timestamp) },
      );
    }
  }
  return [...byTimestamp.values()].sort(
    (left, right) => getPricePointTimestamp(left) - getPricePointTimestamp(right),
  );
}

function historyIntersectsBounds(
  history: TickerFinancials["priceHistory"],
  bounds: DateBounds,
): boolean {
  if (history.length === 0) return false;
  if (bounds.start === null || bounds.end === null) return true;
  return history.some((point) => {
    const timestamp = getPricePointTimestamp(point);
    return Number.isFinite(timestamp) && timestamp >= bounds.start! && timestamp <= bounds.end!;
  });
}

function clampHistoryBoundsToSupport(
  bounds: DateBounds,
  maxRange: TimeRange | null,
): DateBounds {
  if (bounds.start === null || bounds.end === null || !maxRange || maxRange === "ALL") {
    return bounds;
  }
  const supportedStart = subtractTimeRange(new Date(bounds.end), maxRange).getTime();
  return { start: Math.max(bounds.start, supportedStart), end: bounds.end };
}

function latestQuote(snapshot: Quote | undefined, override: Quote | undefined): Quote | undefined {
  if (!snapshot) return override;
  if (!override) return snapshot;
  if (override.lastUpdated !== snapshot.lastUpdated) {
    return override.lastUpdated > snapshot.lastUpdated ? override : snapshot;
  }
  return (override.receivedAt ?? 0) >= (snapshot.receivedAt ?? 0) ? override : snapshot;
}

function mergeHistory(
  financials: TickerFinancials | null,
  history: TickerFinancials["priceHistory"],
  quoteOverride: Quote | undefined,
  now: number,
  liveBarResolution?: ManualChartResolution,
): TickerFinancials {
  const base = financials ?? emptyFinancials();
  const quote = latestQuote(base.quote, quoteOverride);
  const priceHistory = appendLiveQuotePoint(history, quote, liveBarResolution
    ? { now, mode: "ohlc", resolution: liveBarResolution }
    : { now });
  return { ...base, quote, priceHistory };
}

async function loadPriceHistory(
  provider: DataProvider,
  source: Extract<ChartSeriesSpec["source"], { kind: "security" }>,
  request: PriceHistoryRequest,
): Promise<TickerFinancials["priceHistory"]> {
  const context = requestContext(source);
  const detailStart = request.bounds.start === null ? null : new Date(request.bounds.start);
  const detailEnd = exclusiveEnd(request.bounds);
  if (request.explicitWindow && detailStart && detailEnd && provider.getDetailedPriceHistory) {
    try {
      const detailed = await provider.getDetailedPriceHistory(
        source.instrument.symbol,
        source.instrument.exchange ?? "",
        detailStart,
        detailEnd,
        request.resolution,
        context,
      );
      if (historyIntersectsBounds(detailed, request.visibleBounds)) return detailed;
    } catch {
      // Fall through to trailing history when a provider cannot serve the exact window.
    }
  }
  if (provider.getPriceHistoryForResolution) {
    try {
      const resolved = await provider.getPriceHistoryForResolution(
        source.instrument.symbol,
        source.instrument.exchange ?? "",
        request.fallbackRange,
        request.resolution,
        context,
      );
      if (
        resolved.length > 0
        && (!request.explicitWindow || historyIntersectsBounds(resolved, request.visibleBounds))
      ) {
        return resolved;
      }
    } catch {
      // Some providers expose the resolution API but only support a subset.
    }
  }
  if (!request.allowProviderDefaultFallback) {
    // getPriceHistory chooses its own interval, so using it here would make a
    // manual interval label claim a granularity the provider did not honor.
    throw new Error(
      `Requested ${request.resolution} price history is unavailable for ${instrumentLabel(source)}. Choose Auto or a supported interval.`,
    );
  }
  const fallback = await provider.getPriceHistory(
    source.instrument.symbol,
    source.instrument.exchange ?? "",
    request.fallbackRange,
    context,
  );
  if (
    request.explicitWindow
    && fallback.length > 0
    && !historyIntersectsBounds(fallback, request.visibleBounds)
  ) {
    throw new Error(`Price history for the requested window is unavailable for ${instrumentLabel(source)}.`);
  }
  return fallback;
}

function baseSecuritySeries(
  spec: ChartSeriesSpec,
  financials: TickerFinancials,
  index: number,
  marketResolution?: ManualChartResolution,
): ResolvedSeries | null {
  if (spec.source.kind !== "security") return null;
  const field = getTimeSeriesField(spec.source.fieldId);
  if (!field) return null;
  const points = extractSecuritySeries(financials, spec.source);
  const symbol = instrumentLabel(spec.source);
  const currency = financials.quote?.currency;
  const unit = field.unit.startsWith("currency") && currency
    ? field.unit.replace("currency", currency)
    : field.unit;
  const currencyUnitGroup = field.unit.startsWith("currency") && currency
    ? `${field.unitGroup}:${currency}`
    : field.unitGroup;
  const marketExchange = spec.source.instrument.exchange
    || financials.quote?.listingExchangeName
    || financials.quote?.exchangeName;
  const marketTimeZone = isMarketFieldId(spec.source.fieldId)
    && canonicalExchange(marketExchange) !== "CCC"
    ? resolveExchangeTimeZone(marketExchange)
    : null;
  return {
    id: spec.id,
    label: spec.label?.trim() || `${symbol} ${field.shortLabel}`,
    color: spec.color ?? SERIES_COLORS[index % SERIES_COLORS.length]!,
    unit,
    unitGroup: currencyUnitGroup,
    nativeFrequency: spec.source.period && spec.source.period !== "auto"
      ? spec.source.period
      : field.nativeFrequency,
    timestampMode: spec.source.timestampMode,
    dataShape: field.dataShape,
    style: spec.style,
    transform: spec.transform,
    axis: spec.axis === "right" ? "right" : "left",
    panelId: spec.panelId,
    interpolation: spec.interpolation,
    timeBasis: marketTimeZone
      ? {
          kind: "market",
          timeZone: marketTimeZone,
          cadenceMs: marketResolution
            ? CHART_RESOLUTION_STEP_MS[marketResolution]
            : undefined,
        }
      : undefined,
    points,
  };
}

function baseEconomicSeries(
  spec: ChartSeriesSpec,
  loaded: FredSeriesLoadResult,
  index: number,
): ResolvedSeries | null {
  if (spec.source.kind !== "economic") return null;
  const { data } = loaded;
  const units = data.info?.units?.trim() || "value";
  const isPercent = units.toLowerCase().includes("percent");
  return {
    id: spec.id,
    label: spec.label?.trim() || data.info?.title?.trim() || spec.source.seriesId,
    color: spec.color ?? SERIES_COLORS[index % SERIES_COLORS.length]!,
    unit: isPercent ? "%" : units,
    unitGroup: isPercent ? "percent" : `economic:${units.toLowerCase()}`,
    nativeFrequency: "auto",
    timestampMode: "period-end",
    dataShape: "scalar",
    style: spec.style,
    transform: spec.transform,
    axis: spec.axis === "right" ? "right" : "left",
    panelId: spec.panelId,
    interpolation: spec.interpolation,
    points: extractFredSeries(data.observations, { providerId: "fred", timestampMode: "period-end" }),
    warning: "FRED vintage dates are unavailable; observations use period dates.",
  };
}

function staleFredWarning(loaded: FredSeriesLoadResult): string | null {
  if (!loaded.stale) return null;
  return `FRED refresh failed${loaded.refreshError ? ` (${loaded.refreshError})` : ""}; showing cached data fetched ${new Date(loaded.fetchedAt).toISOString().slice(0, 10)}.`;
}

function assignAxes(
  series: ResolvedSeries[],
  specs: readonly { id: string; axis: ChartSeriesSpec["axis"] }[],
  warnings: string[],
): ResolvedSeries[] {
  const requested = new Map(specs.map((spec) => [spec.id, spec.axis] as const));
  const groupsByPanel = new Map<string, Partial<Record<"left" | "right", string>>>();
  return series.map((entry) => {
    const groups = groupsByPanel.get(entry.panelId) ?? {};
    groupsByPanel.set(entry.panelId, groups);
    const preferred = requested.get(entry.id);
    let axis: "left" | "right";
    if (preferred === "left" || preferred === "right") {
      axis = preferred;
    } else if (groups.left === entry.unitGroup) {
      axis = "left";
    } else if (groups.right === entry.unitGroup) {
      axis = "right";
    } else if (!groups.left) {
      axis = "left";
    } else {
      axis = "right";
    }
    if (groups[axis] && groups[axis] !== entry.unitGroup) {
      warnings.push(`${entry.label} shares the ${axis} axis with a different unit; choose an explicit panel for independent scaling.`);
    }
    groups[axis] ??= entry.unitGroup;
    return { ...entry, axis };
  });
}

function prepareBaseSeriesForStudies(
  series: ResolvedSeries,
  bounds: DateBounds,
  clipToBounds = false,
  fallbackBaselineBounds?: DateBounds,
): ResolvedSeries {
  const baselineTransform = series.transform === "percent" || series.transform === "index100";
  let source = series;
  if (clipToBounds && bounds.start !== null && bounds.end !== null) {
    source = clipSeriesToWindow(series, new Date(bounds.start), new Date(bounds.end));
  } else if (clipToBounds) {
    source = { ...series, points: filterPoints(series.points, bounds) };
  }
  const baseline = baselineTransform
    ? scalarBaseline(series, bounds)
      ?? (fallbackBaselineBounds ? scalarBaseline(series, fallbackBaselineBounds) : null)
    : null;
  return applyResolvedSeriesTransform(
    source,
    source.transform,
    baselineTransform ? { baseline } : undefined,
  );
}

function rawCalculationSeries(series: ResolvedSeries, bounds: DateBounds): ResolvedSeries {
  if (bounds.start !== null && bounds.end !== null) {
    return clipSeriesToWindow(series, new Date(bounds.start), new Date(bounds.end));
  }
  return { ...series, points: filterPoints(series.points, bounds) };
}

function scalarBaseline(series: ResolvedSeries, bounds: DateBounds): number | null {
  const points = filterPoints(series.points, bounds);
  for (const point of points) {
    const value = typeof point.value === "number" && Number.isFinite(point.value)
      ? point.value
      : typeof point.close === "number" && Number.isFinite(point.close)
        ? point.close
        : null;
    if (value !== null && value !== 0) return value;
  }
  return null;
}

function studyForOutput(
  outputId: string,
  studies: readonly ChartSpec["studies"][number][],
): ChartSpec["studies"][number] | undefined {
  return studies
    .filter((study) => outputId === study.id || outputId.startsWith(`${study.id}:`))
    .sort((left, right) => right.id.length - left.id.length)[0];
}

function applyStudyPresentationTransforms(
  outputs: ResolvedSeries[],
  studies: readonly ChartSpec["studies"][number][],
  rawSeries: readonly ResolvedSeries[],
  visibleBounds: DateBounds,
  fallbackBaselineBounds?: DateBounds,
): ResolvedSeries[] {
  const rawById = new Map(rawSeries.map((series) => [series.id, series] as const));
  return outputs.map((output) => {
    const study = studyForOutput(output.id, studies);
    if (!study || (study.kind !== "sma" && study.kind !== "ema" && study.kind !== "bollinger")) {
      return output;
    }
    const input = rawById.get(study.inputSeriesIds[0] ?? "");
    if (!input || input.transform === "raw") return output;
    const baseline = input.transform === "percent" || input.transform === "index100"
      ? scalarBaseline(input, visibleBounds)
        ?? (fallbackBaselineBounds ? scalarBaseline(input, fallbackBaselineBounds) : null)
      : undefined;
    return applyResolvedSeriesTransform(output, input.transform, { baseline });
  });
}

export async function resolveChartSpecData(
  spec: ChartSpec,
  sources: ChartResolveSources,
  cache = new ChartResolveCache(),
  options: ChartResolveOptions = {},
): Promise<ChartResolutionResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const priorityWarnings: string[] = [];
  const baseSeriesIds = new Set(spec.series.map((entry) => entry.id));
  const visibleSeriesIds = new Set(spec.series
    .filter((entry) => entry.visible !== false)
    .map((entry) => entry.id));
  const calculationSeriesIds = activeStudyInputSeriesIds(spec.studies);
  visibleSeriesIds.forEach((id) => calculationSeriesIds.add(id));
  // Keep the first authored market series loaded as the deterministic shared
  // session anchor even when the user temporarily hides its marks.
  const primaryMarketSeries = spec.series.find((entry) => (
    entry.source.kind === "security" && isMarketFieldId(entry.source.fieldId)
  ));
  if (primaryMarketSeries) calculationSeriesIds.add(primaryMarketSeries.id);
  if (!sources.dataProvider && spec.series.some((entry) => (
    calculationSeriesIds.has(entry.id) && entry.source.kind === "security"
  ))) {
    return { series: [], loading: false, errors: ["Market data is unavailable."], warnings };
  }

  const referenceNow = sources.now ?? new Date();
  const initialVisibleBounds = requestedBounds(spec, referenceNow);

  const loadFinancials = (source: Extract<ChartSeriesSpec["source"], { kind: "security" }>) => {
    const key = instrumentKey(source);
    let pending = cache.financialsByInstrument.get(key);
    if (!pending) {
      pending = sources.dataProvider!
        .getTickerFinancials(
          source.instrument.symbol,
          source.instrument.exchange ?? "",
          requestContext(source),
        )
        .catch(() => null);
      cache.financialsByInstrument.set(key, pending);
    }
    return pending;
  };
  const loadResolutionSupport = (
    source: Extract<ChartSeriesSpec["source"], { kind: "security" }>,
  ) => {
    const provider = sources.dataProvider!;
    if (!provider.getChartResolutionSupport) return Promise.resolve([]);
    const key = `${provider.id}|${instrumentKey(source)}`;
    let pending = cache.resolutionSupportByInstrument.get(key);
    if (!pending) {
      pending = Promise.resolve(provider.getChartResolutionSupport(
        source.instrument.symbol,
        source.instrument.exchange ?? "",
        requestContext(source),
      )).catch(() => []);
      cache.resolutionSupportByInstrument.set(key, pending);
    }
    return pending;
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
  const resolutionSupportSources = await Promise.all(activeMarketSources.map(async (source) => (
    source.instrument.exchange?.trim()
      ? source
      : sourceWithResolvedExchange(source, await loadFinancials(source))
  )));
  const sharedSupport = activeMarketSources.length > 0
    ? intersectChartResolutionSupport(await Promise.all(
        resolutionSupportSources.map((source) => loadResolutionSupport(source)),
      ))
    : [];
  const initialResolution = requestResolution(
    spec,
    initialVisibleBounds,
    calculationSeriesIds,
    options,
    sharedSupport,
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
  const initialCalculationBounds = calculationBounds(
    spec,
    requestVisibleBounds,
    initialResolution,
  );
  const hasExplicitWindow = explicitBounds(spec) !== null
    || (requestBounds !== null && !sameBounds(requestBounds, initialVisibleBounds));

  const loadHistory = async (
    source: Extract<ChartSeriesSpec["source"], { kind: "security" }>,
    all = false,
  ) => {
    const support = await loadResolutionSupport(source);
    const maxRange = getSupportMaxRange(support, initialResolution);
    const historyBounds = clampHistoryBoundsToSupport(initialCalculationBounds, maxRange);
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
      fallbackRange,
      resolution: initialResolution,
      allowProviderDefaultFallback: spec.viewport.resolution === "auto",
    };
    const key = [
      instrumentKey(source),
      request.resolution,
      request.fallbackRange,
      ...(request.explicitWindow
        ? [request.bounds.start ?? "open", request.bounds.end ?? "open"]
        : []),
    ].join("|");
    let pending = cache.priceHistoryByRequest.get(key);
    if (!pending) {
      pending = loadPriceHistory(sources.dataProvider!, source, request);
      cache.priceHistoryByRequest.set(key, pending);
    }
    const history = await pending;
    const accumulationKey = `${instrumentKey(source)}|${request.resolution}`;
    const previousHistory = cache.accumulatedPriceHistory.get(accumulationKey) ?? [];
    if (
      request.explicitWindow
      && !historyIntersectsBounds(history, request.visibleBounds)
      && !historyIntersectsBounds(previousHistory, request.visibleBounds)
    ) {
      throw new Error(
        `Price history for the requested window is unavailable for ${instrumentLabel(source)}.`,
      );
    }
    const accumulated = mergePriceHistoryWindows(
      previousHistory,
      history,
    );
    cache.accumulatedPriceHistory.set(accumulationKey, accumulated);
    return accumulated;
  };

  const loadEconomicSeries = (request: FredSeriesRequest) => {
    const key = `${request.seriesId.trim().toUpperCase()}|${request.startDate}|${request.sortOrder}`;
    let pending = cache.fredSeriesByRequest.get(key);
    if (!pending) {
      pending = sources.loadFredSeries(request);
      cache.fredSeriesByRequest.set(key, pending);
    }
    return pending;
  };

  const loaded = await Promise.all(spec.series.map(async (seriesSpec, index) => {
    if (!calculationSeriesIds.has(seriesSpec.id)) return null;
    try {
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
        const freshnessWarning = staleFredWarning(fred);
        if (result && freshnessWarning) priorityWarnings.push(`${result.label}: ${freshnessWarning}`);
        return result;
      }

      const source = seriesSpec.source;
      const marketField = isMarketFieldId(source.fieldId);
      const quoteDerivedValuation = valuationSeriesUsesLiveQuote(source.fieldId);
      const needsHistory = marketField || quoteDerivedValuation;
      const quoteOverride = marketField || quoteDerivedValuation
        ? sources.quoteOverrides?.get(chartQuoteOverrideKeyForSource(source))
        : undefined;
      const financialsPromise = loadFinancials(source);
      let resolvedSource = source;
      let financials: TickerFinancials | null;
      let history: TickerFinancials["priceHistory"] | null;
      if (needsHistory && !source.instrument.exchange?.trim()) {
        financials = await financialsPromise;
        resolvedSource = sourceWithResolvedExchange(source, financials);
        history = await loadHistory(resolvedSource, quoteDerivedValuation);
      } else {
        [financials, history] = await Promise.all([
          financialsPromise,
          needsHistory ? loadHistory(source, quoteDerivedValuation) : Promise.resolve(null),
        ]);
        resolvedSource = sourceWithResolvedExchange(source, financials);
      }
      const liveBarResolution = isOhlcSeriesStyle(seriesSpec.style) ? initialResolution : undefined;
      const merged = history
        ? mergeHistory(financials, history, quoteOverride, referenceNow.getTime(), liveBarResolution)
        : quoteOverride && financials
          ? { ...financials, quote: latestQuote(financials.quote, quoteOverride) }
          : financials;
      if (!merged) throw new Error(`No financial data is available for ${instrumentLabel(source)}.`);
      const result = baseSecuritySeries(
        resolvedSource === source ? seriesSpec : { ...seriesSpec, source: resolvedSource },
        merged,
        index,
        initialResolution,
      );
      if (!result) throw new Error(`Unknown field ${source.fieldId}.`);
      if (isFundamentalFieldId(source.fieldId) && fundamentalSeriesUsesAvailabilityFallback(merged, source)) {
        result.warning = "Publication dates are unavailable for some observations; period-end dates are used as a fallback.";
      }
      return result;
    } catch (error) {
      errors.push(`${seriesSpec.label ?? seriesSpec.id}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }));

  const rawSeries = loaded.filter((entry): entry is ResolvedSeries => !!entry);
  const marketTimelineSeries = primaryMarketSeries?.visible === false
    ? rawSeries.filter((entry) => entry.id === primaryMarketSeries.id)
    : [];
  // Preset ranges describe a window ending at the requested reference time,
  // even when the newest filing or economic observation lags that endpoint.
  // Re-anchoring to the latest observation both mislabels the range and asks
  // providers for a different window than the one ultimately rendered.
  const bounds = initialVisibleBounds;
  const resolution = initialResolution;
  const studyBounds = initialCalculationBounds;
  const baseSeries = rawSeries
    .filter((entry) => visibleSeriesIds.has(entry.id))
    .map((entry) => prepareBaseSeriesForStudies(entry, bounds, false, requestVisibleBounds));
  const calculationSeries = rawSeries.map((entry) => rawCalculationSeries(entry, studyBounds));
  let resolved = baseSeries;

  // Study outputs are appended by the pure engine before the final viewport clip.
  if (spec.studies.length > 0) {
    const studyResult = resolveStudies(calculationSeries, spec.studies);
    resolved = [
      ...resolved,
      ...applyStudyPresentationTransforms(
        studyResult.series,
        spec.studies,
        rawSeries,
        bounds,
        requestVisibleBounds,
      ),
    ];
    warnings.push(...studyResult.warnings);
    errors.push(...studyResult.errors);
  }

  const bufferedSeries = assignAxes(resolved, [...spec.series, ...spec.studies], warnings);
  resolved = bufferedSeries.map((entry) => (
    bounds.start !== null && bounds.end !== null
      ? clipSeriesToWindow(entry, new Date(bounds.start), new Date(bounds.end))
      : { ...entry, points: filterPoints(entry.points, bounds) }
  ));
  if (spec.viewport.maxPoints !== undefined) {
    resolved = resolved.map((entry) => ({
      ...entry,
      points: entry.points.slice(-spec.viewport.maxPoints!),
    }));
  }
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
    if (entry.points.length === 0) warnings.push(`${entry.label}: no observations in the selected date range.`);
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

  const exposeViewport = hasExplicitWindow || spec.viewport.maxPoints === undefined;
  const viewport = exposeViewport && bounds.start !== null && bounds.end !== null
    ? { start: new Date(bounds.start), end: new Date(bounds.end) }
    : undefined;
  return {
    series: resolved,
    ...(sharedSupport.length > 0 ? { resolutionSupport: sharedSupport } : {}),
    legendSeries,
    ...(spec.viewport.maxPoints === undefined ? { bufferedSeries } : {}),
    ...(marketTimelineSeries.length > 0 ? { timelineSeries: marketTimelineSeries } : {}),
    loading: false,
    errors,
    warnings: [...new Set([...priorityWarnings, ...warnings])],
    viewport,
  };
}
