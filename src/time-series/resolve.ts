import { resolveAssetDisplayKind } from "../market-data/market/format";
import { hasValidQuoteObservationTime } from "../market-data/quotes/freshness";
import { SnapshotHistoryUnavailableError } from "../market-data/snapshot-provider";
import { financialPeriodCoverage, financialPeriodCoverageWarnings, limitSeriesObservations } from "./financial-period-coverage";
import { HistoryCoverageError, historyCoverageNotice, isShellLondonTarget } from "../sources/history-coverage";
import { HISTORY_RETENTION_MAX_AGE_MS, canonicalHistoryInterval, isHistoryRetentionError, parseHistoryRecoveryCandidate, type HistoryRecoveryCandidate, type HistoryRetentionError } from "../sources/history-retention";
import { getRouterEntityKey } from "../sources/provider-router/cache";
import { publicListingTarget } from "../sources/listing-target";
import { fetchHistoryResult } from "../sources/history-result";
import type { PriceHistoryResult } from "../types/price-history";
import { FINANCIAL_VINTAGE_NOTICE, SEC_EPS_BASIS_NOTICE } from "../utils/financial-statements";
import { appendLiveQuotePoint, hasUnknownBondHistoryBasis } from "./chart-data";
import {
  getTimeRangeForDateWindow,
  isDateWindowWithinTimeRange,
  subtractTimeRange,
} from "./date-window";
import {
  CHART_RESOLUTION_STEP_MS,
  clampTimeRangeToMaxRange,
  DEFAULT_CHART_RESOLUTION_SUPPORT,
  getBestSupportedResolutionForVisibleWindow,
  getNextBufferRange,
  getSupportedPresetResolution,
  getSupportMaxRange,
  intersectChartResolutionSupport,
  isIntradayResolution,
  normalizeChartResolutionSupport,
  TIME_RANGE_ORDER,
  type ChartResolutionSupport,
  type ManualChartResolution,
} from "./resolution";
import type { TimeRange } from "./range";
import type { DataProvider, MarketDataRequestContext } from "../types/data-provider";
import type { Quote, QuoteMetadata, TickerFinancials } from "../types/financials";
import { mergeQuoteMetadata, quoteMetadataFromQuote, quoteMetadataMatchesTarget } from "../market-data/quotes/metadata";
import type { FredSeriesLoadResult, FredSeriesRequest } from "../data/fred-series";
import { extractFredSeries, fredCreditCoverageNotice } from "./economic";
import {
  getTimeSeriesField,
  isFundamentalFieldId,
  isMarketFieldId,
  isPriceOnlyMarketFieldId,
} from "./field-catalog";
import {
  fundamentalSeriesUsesAvailabilityFallback,
  valuationCurrencyWarning,
  valuationPriceIssues,
  valuationSeriesUsesLiveQuote,
  valuationSeriesUsesPriceHistory,
} from "./fundamentals";
import { FORWARD_PE_BASIS_NOTICE, REALIZED_NTM_PE_BASIS_NOTICE } from "./forward-valuation";
import { valuationPriceWarning } from "./valuation-price";
import { extractSecuritySeries, collectPriceHistoryIntegrity, chartPriceHistoryIntegrityNotices } from "./market";
import {
  activeStudyInputSeriesIds,
  maxStudyWarmupPoints,
  resolveStudies,
} from "./studies";
import { applyResolvedSeriesTransform } from "./transforms";
import { clipSeriesToWindow } from "./alignment";
import { clipPriceComparison, priceComparisonBoundsForSeries, priceComparisonSeriesIds, priceObservationWindowFilter, resolvePriceComparison, type PriceComparison } from "./price-comparison";
import { reportingCurrencySeries } from "./reporting-currency";
import { chartQuoteOverrideKeyForSource, compareChartQuoteRecency } from "./live-quotes";
import { chartSeriesSourceKey } from "../capabilities/chart-series";
import { isResolutionFineEnoughForMarketPeriod, resolutionForExplicitMarketPeriods } from "./market-resolution";
import { marketSeriesFrequency } from "./market";
import {
  rememberParsedPriceHistory,
  parsedPriceHistoryKey,
} from "./parsed-history-cache";
import {
  canonicalExchange,
  publicTickerKey,
  resolveExchangeTimeZone,
} from "../utils/exchanges";
import { getPricePointTimestamp, isPriceHistoryStaleForCurrentWindow } from "../utils/price-history";
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
  /** Capture the resolved inputs, including the calculation buffer, for an export. */
  onSecurityData?: (series: ChartSeriesSpec, data: TickerFinancials, includesHistory: boolean) => void;
  /** Provider-neutral boundary for plugin-owned chart series. */
  resolveCapabilitySeries?: (
    source: Extract<ChartSeriesSpec["source"], { kind: "capability" }>,
    viewport: ChartSpec["viewport"],
    spec: ChartSeriesSpec,
  ) => Promise<ResolvedSeries>;
}

export interface ChartResolveOptions {
  /** Runtime zoom window used only to choose an adaptive Auto resolution. */
  autoViewport?: { start: Date; end: Date } | null;
  /** Runtime interaction window used to load history around the visible chart. */
  requestViewport?: { start: Date; end: Date } | null;
  /** Approximate number of horizontal observations the current surface can use. */
  targetPointCount?: number;
  /** Resolution currently on screen, kept through small Auto zooms. */
  currentResolution?: ManualChartResolution | null;
  /**
   * Price-only charts paint before slow broker support answers and stand in a
   * placeholder list meanwhile. One-shot loaders wait for the real list.
   */
  awaitResolutionSupport?: boolean;
  /** Fired once the real support list lands after a placeholder was used. */
  onResolutionSupportSettled?: () => void;
}

/** Raw source data retained while live quotes recompute the chart tail. */
export class ChartResolveCache {
  readonly financialsByInstrument = new Map<string, Promise<TickerFinancials | null>>();
  readonly quoteMetadataByInstrument = new Map<string, Promise<QuoteMetadata | null>>();
  readonly priceHistoryByRequest = new Map<string, Promise<LoadedPriceHistory>>();
  readonly priceHistoryExpiryByRequest = new Map<string, number>();
  readonly priceHistoryRefreshAfter = new Map<string, number>();
  readonly accumulatedPriceHistory = new Map<string, LoadedPriceHistory>();
  readonly resolutionSupportByInstrument = new Map<string, Promise<ChartResolutionSupport[]>>();
  readonly settledResolutionSupport = new Map<string, ChartResolutionSupport[]>();
  readonly rejectedResolutionSupport = new Set<string>();
  readonly fredSeriesByRequest = new Map<string, Promise<FredSeriesLoadResult>>();
  readonly capabilitySeriesByRequest = new Map<string, Promise<ResolvedSeries>>();
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
  support: readonly ChartResolutionSupport[];
  requiredWarmupPoints: number;
  historyRequestKey?: string;
}

interface LoadedPriceHistory extends PriceHistoryResult {
  expiresAt?: number;
  requestKey?: string;
  recovery?: {
    sourceKey: string;
    start: number;
    end: number;
    requiredWarmupPoints: number;
    usableWarmupPoints: number;
  };
}

class PriceHistoryAcquisitionError extends Error {
  constructor(message: string, readonly retryAt: number) { super(message); }
}

/** Compatible intervals from different source/session contracts cannot share a capture. */
export function priceHistoryAcquisitionIdentity(result: Pick<PriceHistoryResult, "session" | "sourceKey">): string {
  const { observedAt: _observedAt, ...session } = result.session ?? {};
  return JSON.stringify([result.sourceKey ?? null, result.session ? session : null]);
}

/** Merged history keeps the actual acquisition clock belonging to its finite tail. */
export function priceHistoryTailAcquisition<T extends { points: TickerFinancials["priceHistory"] }>(previous: T | undefined, incoming: T): T {
  const latest = (value: T) => value.points.reduce((last, point) => {
    const time = getPricePointTimestamp(point);
    return Number.isFinite(point.close) && Number.isFinite(time) ? Math.max(last, time) : last;
  }, Number.NEGATIVE_INFINITY);
  return previous && latest(previous) > latest(incoming) ? previous : incoming;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function requestContext(spec: Extract<ChartSeriesSpec["source"], { kind: "security" }>): MarketDataRequestContext {
  return {
    brokerId: spec.instrument.instrument?.brokerId ?? spec.instrument.brokerId,
    brokerInstanceId: spec.instrument.instrument?.brokerInstanceId ?? spec.instrument.brokerInstanceId,
    instrument: spec.instrument.instrument ?? null,
  };
}

function instrumentKey(spec: Extract<ChartSeriesSpec["source"], { kind: "security" }>): string {
  return chartQuoteOverrideKeyForSource(spec);
}

function instrumentLabel(spec: Extract<ChartSeriesSpec["source"], { kind: "security" }>): string {
  return publicTickerKey(spec.instrument.symbol, spec.instrument.exchange);
}

// A series that fails to load keeps its place with no observations. Dropping it
// made a series the user had added disappear from the legend while it still sat
// in the series editor, with nothing on screen to explain the difference.
function unloadableSeries(spec: ChartSeriesSpec, index: number, warning: string): ResolvedSeries {
  const field = spec.source.kind === "security" ? getTimeSeriesField(spec.source.fieldId) : undefined;
  const label = spec.source.kind === "security"
    ? `${instrumentLabel(spec.source)} ${field?.shortLabel ?? spec.source.fieldId.split(".").at(-1) ?? "Series"}`
    : spec.source.kind === "economic"
      ? `FRED ${spec.source.seriesId}`
      : spec.source.seriesId;
  return {
    id: spec.id,
    label: spec.label?.trim() || label,
    color: spec.color ?? SERIES_COLORS[index % SERIES_COLORS.length]!,
    unit: field?.unit ?? "",
    unitGroup: field?.unitGroup ?? "unknown",
    nativeFrequency: field?.nativeFrequency ?? "daily",
    dataShape: field?.dataShape ?? "scalar",
    style: spec.style,
    transform: spec.transform,
    axis: spec.axis === "right" ? "right" : "left",
    panelId: spec.panelId,
    interpolation: spec.interpolation,
    warning,
    points: [],
  };
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

/** Calendar range limits use the authored dates; observation filters include the final day. */
function rangeDurationBounds(spec: ChartSpec, bounds: DateBounds): DateBounds {
  const window = spec.viewport.dateWindow;
  if (!window || !DATE_ONLY_PATTERN.test(window.start) || !DATE_ONLY_PATTERN.test(window.end)
    || bounds.end !== inclusiveEndDate(window.end)?.getTime()) return bounds;
  return { ...bounds, end: finiteDate(window.end)!.getTime() };
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
  provisionalSupport = false,
): ManualChartResolution {
  const duration = rangeDurationBounds(spec, bounds);
  if (spec.viewport.resolution === "auto" && spec.studies.some((study) => study.kind === "realized-vol" && study.visible !== false)) {
    // A 252-session estimator must see daily observations even on a long chart.
    const maxRange = getSupportMaxRange(sharedSupport, "1d");
    if (sharedSupport.length === 0 || provisionalSupport || maxRange === "ALL"
      || (maxRange !== null && duration.start !== null && duration.end !== null
        && isDateWindowWithinTimeRange(new Date(duration.start), new Date(duration.end), maxRange))) return "1d";
  }
  if (spec.viewport.resolution !== "auto") {
    const maxRange = getSupportMaxRange(sharedSupport, spec.viewport.resolution);
    // A placeholder list cannot rule out a manual pick; the real list decides
    // on the next pass.
    const supported = sharedSupport.length === 0
      || provisionalSupport
      || maxRange === "ALL"
      || (
        maxRange !== null
        && duration.start !== null
        && duration.end !== null
        && isDateWindowWithinTimeRange(
          new Date(duration.start),
          new Date(duration.end),
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
        options.currentResolution,
      )
    : null;
  const preferred = adaptive
    ?? getSupportedPresetResolution(
      explicitBounds(spec) ? boundsRange(duration) : spec.viewport.range,
      provisionalSupport ? [] : sharedSupport,
      duration.start !== null && duration.end !== null
        ? { start: new Date(duration.start), end: new Date(duration.end) }
        : null,
    );
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

  const duration = rangeDurationBounds(spec, visibleBounds);
  const visibleEnd = duration.end ?? visibleBounds.start;
  const bufferedRange = getNextBufferRange(boundsRange(duration));
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

function resolvePriceHistoryIntegrity(
  spec: ChartSpec,
  requestedSeries: readonly ResolvedSeries[],
  visibleSeries: readonly ResolvedSeries[],
  bounds: DateBounds,
  resolution: ManualChartResolution | "auto",
  dateWindow: ChartSpec["viewport"]["dateWindow"] | null,
) {
  const filters = new Map(requestedSeries.map((entry) => [entry.id, priceObservationWindowFilter(entry, bounds, resolution, dateWindow)]));
  const requestedIds = activeStudyInputSeriesIds(spec.studies);
  spec.series.filter((entry) => entry.visible !== false).forEach((entry) => requestedIds.add(entry.id));
  const selected = requestedSeries.filter((entry) => requestedIds.has(entry.id)).map((entry) => limitSeriesObservations(spec, {
    ...entry, points: entry.points.filter((point) => filters.get(entry.id)!(point.date.getTime())),
  }));
  return [
    ...collectPriceHistoryIntegrity(selected, "requested-observation", (id, time) => filters.get(id)!(time)),
    ...collectPriceHistoryIntegrity(visibleSeries, "visible-calculation"),
  ];
}

function comparisonDisplayBounds(bounds: DateBounds, comparison: PriceComparison | null): DateBounds {
  if (comparison?.alignment !== "session-date" || comparison.start === null || comparison.end === null) return bounds;
  // A date-only selection can include a local session that began on the prior
  // UTC day. Keep its original timestamp visible in the rendering viewport.
  return {
    start: bounds.start === null ? null : Math.min(bounds.start, comparison.start),
    end: bounds.end === null ? null : Math.max(bounds.end, comparison.end),
  };
}

function followLatestMarketObservation(
  bounds: DateBounds,
  series: readonly ResolvedSeries[],
): DateBounds {
  if (bounds.end === null) return bounds;
  let latest = bounds.end;
  for (const entry of series) {
    if (entry.timeBasis?.kind !== "market") continue;
    for (const point of entry.points) {
      const timestamp = point.date.getTime();
      if (Number.isFinite(timestamp) && timestamp > latest) latest = timestamp;
    }
  }
  if (latest === bounds.end) return bounds;
  const shift = latest - bounds.end;
  return {
    start: bounds.start === null ? null : bounds.start + shift,
    end: latest,
  };
}

function emptyFinancials(priceHistory: TickerFinancials["priceHistory"] = []): TickerFinancials {
  return { annualStatements: [], quarterlyStatements: [], priceHistory };
}

function chartCalculationSeriesIds(spec: ChartSpec): Set<string> {
  const ids = activeStudyInputSeriesIds(spec.studies);
  spec.series.filter(entry => entry.visible !== false).forEach(entry => ids.add(entry.id));
  // Hidden primary market data still owns the shared session anchor.
  const primary = spec.series.find(entry => entry.source.kind === "security" && isMarketFieldId(entry.source.fieldId));
  if (primary) ids.add(primary.id);
  return ids;
}

/** Select the provisional seed cadence before provider resolution support arrives. */
export function chartSeedResolution(spec: ChartSpec, now: Date, options: ChartResolveOptions = {}): ManualChartResolution {
  return requestResolution(spec, requestedBounds(spec, now), chartCalculationSeriesIds(spec), options, []);
}

export function seedChartResolutionResult(
  spec: ChartSpec,
  historyByInstrument: ReadonlyMap<string, TickerFinancials["priceHistory"]>,
  referenceNow?: Date,
  options: ChartResolveOptions = {},
): ChartResolutionResult | null {
  const series: ResolvedSeries[] = [];
  spec.series.forEach((seriesSpec, index) => {
    if (seriesSpec.visible === false || seriesSpec.source.kind !== "security") return;
    if (!isMarketFieldId(seriesSpec.source.fieldId)) return;
    const history = historyByInstrument.get(instrumentKey(seriesSpec.source));
    if (!history?.length) return;
    const resolved = baseSecuritySeries(seriesSpec, emptyFinancials(history), index);
    if (resolved?.points.length) series.push(resolved);
  });
  if (series.length === 0) return null;
  let latest = Number.NEGATIVE_INFINITY;
  for (const entry of series) {
    for (const point of entry.points) latest = Math.max(latest, point.date.getTime());
  }
  const bounds = requestedBounds(spec, referenceNow ?? new Date(latest));
  const resolution = chartSeedResolution(spec, referenceNow ?? new Date(latest), options);
  const priceComparison = resolvePriceComparison(spec, series, bounds, resolution);
  const displayBounds = comparisonDisplayBounds(bounds, priceComparison);
  const comparisonBounds = priceComparison && priceComparison.start !== null
    ? priceComparison : bounds;
  const baseSeries = series.map((entry) => prepareBaseSeriesForStudies(entry, priceComparisonBoundsForSeries(entry, priceComparison) ?? comparisonBounds));
  // Calculate studies from raw buffered inputs, then use the same presentation
  // and visible-window rules as the network result.
  const studies = resolveStudies(series, spec.studies, resolution);
  const bufferedSeries = [
    ...baseSeries,
    ...applyStudyPresentationTransforms(studies.series, spec.studies, series, comparisonBounds, undefined, priceComparison),
  ].map((entry) => clipPriceComparison(entry, priceComparison));
  const visible = bufferedSeries.map((entry) => {
    const entryBounds = presentationBounds(entry, spec.studies, priceComparison, bounds);
    const clipped = entryBounds.start !== null && entryBounds.end !== null
      ? clipSeriesToWindow(entry, new Date(entryBounds.start), new Date(entryBounds.end))
      : { ...entry, points: filterPoints(entry.points, entryBounds) };
    return clipPriceComparison(limitSeriesObservations(spec, clipped), priceComparison);
  });
  const priceHistoryIntegrity = resolvePriceHistoryIntegrity(spec, series, visible, bounds, resolution, spec.viewport.dateWindow ?? null);
  return {
    series: visible,
    ...(priceHistoryIntegrity.length ? { priceHistoryIntegrity } : {}),
    ...(priceComparison ? { priceComparison } : {}),
    legendSeries: visible,
    ...(spec.viewport.maxPoints === undefined ? { bufferedSeries } : {}),
    ...((explicitBounds(spec) !== null || spec.viewport.maxPoints === undefined)
      && displayBounds.start !== null && displayBounds.end !== null
      ? { viewport: { start: new Date(displayBounds.start), end: new Date(displayBounds.end) } } : {}),
    loading: true,
    errors: studies.errors,
    warnings: [...studies.warnings, ...chartPriceHistoryIntegrityNotices(priceHistoryIntegrity), ...(priceComparison ? [priceComparison.notice] : [])],
    resolution,
  };
}


function chartIsPriceOnly(spec: ChartSpec, calculationSeriesIds: ReadonlySet<string>): boolean {
  return spec.series.every((entry) => {
    if (!calculationSeriesIds.has(entry.id) || entry.source.kind !== "security") return true;
    return isPriceOnlyMarketFieldId(entry.source.fieldId);
  });
}

function isSortedPriceHistory(points: TickerFinancials["priceHistory"]): boolean {
  let previous = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    const timestamp = getPricePointTimestamp(point);
    if (!Number.isFinite(timestamp)) continue;
    if (timestamp < previous) return false;
    previous = timestamp;
  }
  return true;
}

export function mergePriceHistoryWindows(
  current: TickerFinancials["priceHistory"],
  incoming: TickerFinancials["priceHistory"],
  resolution: ManualChartResolution,
): TickerFinancials["priceHistory"] {
  let sorted: TickerFinancials["priceHistory"];
  if (!isSortedPriceHistory(current) || !isSortedPriceHistory(incoming)) {
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
    sorted = [...byTimestamp.values()].sort(
      (left, right) => getPricePointTimestamp(left) - getPricePointTimestamp(right),
    );
  } else {
    sorted = [];
    let currentIndex = 0;
    let incomingIndex = 0;
    const append = (
      point: TickerFinancials["priceHistory"][number],
      timestamp: number,
    ) => {
      const normalized = point.date instanceof Date ? point : { ...point, date: new Date(timestamp) };
      const previous = sorted.at(-1);
      if (previous && getPricePointTimestamp(previous) === timestamp) sorted[sorted.length - 1] = normalized;
      else sorted.push(normalized);
    };

    while (currentIndex < current.length || incomingIndex < incoming.length) {
      const currentPoint = current[currentIndex];
      const incomingPoint = incoming[incomingIndex];
      const currentTimestamp = currentPoint ? getPricePointTimestamp(currentPoint) : Number.POSITIVE_INFINITY;
      const incomingTimestamp = incomingPoint ? getPricePointTimestamp(incomingPoint) : Number.POSITIVE_INFINITY;
      if (currentPoint && !Number.isFinite(currentTimestamp)) {
        currentIndex += 1;
      } else if (incomingPoint && !Number.isFinite(incomingTimestamp)) {
        incomingIndex += 1;
      } else if (currentPoint && currentTimestamp <= incomingTimestamp) {
        append(currentPoint, currentTimestamp);
        currentIndex += 1;
      } else if (incomingPoint) {
        append(incomingPoint, incomingTimestamp);
        incomingIndex += 1;
      }
    }
  }

  if (isIntradayResolution(resolution)) return sorted;
  // Windows can be served by different sources, and they stamp the same session
  // differently: local midnight, UTC midnight, or the opening bell. Keying on the
  // exact timestamp keeps both copies, so the chart draws every bar twice and
  // carries twice the points through every pan. Daily and slower bars are never
  // closer than one step apart, so anything closer is the same session; keep the
  // copy already plotted to leave existing bars where they are.
  const minimumGapMs = CHART_RESOLUTION_STEP_MS[resolution] * 0.8;
  const plotted = new Set(current.map(getPricePointTimestamp));
  const merged: TickerFinancials["priceHistory"] = [];
  for (const point of sorted) {
    const previous = merged.at(-1);
    if (!previous || getPricePointTimestamp(point) - getPricePointTimestamp(previous) >= minimumGapMs) {
      merged.push(point);
      continue;
    }
    if (!plotted.has(getPricePointTimestamp(previous)) && plotted.has(getPricePointTimestamp(point))) {
      merged[merged.length - 1] = point;
    }
  }
  return merged;
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
  durationEnd: number | null = bounds.end,
): DateBounds {
  if (bounds.start === null || bounds.end === null || !maxRange || maxRange === "ALL") {
    return bounds;
  }
  const supportedStart = subtractTimeRange(new Date(durationEnd ?? bounds.end), maxRange).getTime();
  return { start: Math.max(bounds.start, supportedStart), end: bounds.end };
}

function latestQuote(snapshot: Quote | undefined, override: Quote | undefined): Quote | undefined {
  if (!snapshot) return override;
  if (!override) return snapshot;
  return compareChartQuoteRecency(override, snapshot) >= 0 ? override : snapshot;
}

function mergeHistory(
  financials: TickerFinancials | null,
  history: TickerFinancials["priceHistory"],
  quoteOverride: Quote | undefined,
  now: number,
  liveBarResolution?: ManualChartResolution,
  exchange?: string,
  appendQuote = true,
  assetCategory?: string,
): TickerFinancials {
  const base = financials ?? emptyFinancials();
  const quote = latestQuote(base.quote, quoteOverride);
  const unknownHistoryBasis = hasUnknownBondHistoryBasis(quote, assetCategory, base.quoteMetadata?.instrumentType);
  const priceHistory = appendQuote && !unknownHistoryBasis ? appendLiveQuotePoint(history, quote, liveBarResolution
    ? { now, mode: "ohlc", resolution: liveBarResolution, exchange }
    : { now }) : history;
  return { ...base, quote, priceHistory };
}

function retainedWarmup(points: TickerFinancials["priceHistory"], visibleStart: number | null): number {
  return visibleStart === null ? 0 : points.filter((point) => Number.isFinite(point.close)
    && getPricePointTimestamp(point) < visibleStart).length;
}

function recoveryCandidates(
  error: HistoryRetentionError,
  provider: DataProvider,
  source: Extract<ChartSeriesSpec["source"], { kind: "security" }>,
): readonly HistoryRecoveryCandidate[] {
  if (error.candidates.length) return error.candidates;
  // A direct Cloud adapter enforces this constraint itself. Routed errors must
  // carry the router's actual attempted-source scope, including across RPC.
  if (provider.id !== "gloomberb-cloud") return [];
  const target = publicListingTarget(source.instrument.symbol, source.instrument.exchange);
  const context = requestContext(source);
  const candidate = parseHistoryRecoveryCandidate({
    sourceKey: `provider:${provider.id}`, retention: error.retention,
    request: { symbol: target.symbol, exchange: target.exchange ?? "",
      entityKey: getRouterEntityKey(source.instrument.symbol, context.instrument),
      brokerId: context.brokerId, brokerInstanceId: context.brokerInstanceId,
      interval: error.retention.interval, requestedStart: error.retention.requestedStart,
      requestedEnd: error.retention.requestedEnd },
  });
  return candidate ? [candidate] : [];
}

async function loadPriceHistory(
  provider: DataProvider,
  source: Extract<ChartSeriesSpec["source"], { kind: "security" }>,
  request: PriceHistoryRequest,
): Promise<LoadedPriceHistory> {
  const context = { ...requestContext(source), historyRequestKey: request.historyRequestKey };
  let coverageNotice: string | null = null;
  let retentionError: HistoryRetentionError | null = null;
  const observeFailure = (error: unknown) => {
    if (error instanceof SnapshotHistoryUnavailableError) throw error;
    if (error instanceof HistoryCoverageError) coverageNotice ??= error.message;
    if (isHistoryRetentionError(error)) retentionError ??= error;
  };
  const observeCoverage = (points: TickerFinancials["priceHistory"]) => {
    if (isShellLondonTarget(source.instrument.symbol, source.instrument.exchange)) {
      coverageNotice ??= historyCoverageNotice(points, request.visibleBounds.start);
    }
  };
  const accepted = (points: TickerFinancials["priceHistory"]) => points.length > 0
    && (!request.explicitWindow || historyIntersectsBounds(points, request.visibleBounds));
  const detailStart = request.bounds.start === null ? null : new Date(request.bounds.start);
  const detailEnd = exclusiveEnd(request.bounds);
  if (request.explicitWindow && detailStart && detailEnd && (provider.getDetailedPriceHistoryWithMetadata || provider.getDetailedPriceHistory)) {
    try {
      const result = (await fetchHistoryResult(provider, source.instrument.symbol, source.instrument.exchange ?? "",
        { kind: "detail", start: detailStart, end: detailEnd, interval: request.resolution }, context))!;
      const { points } = result;
      observeCoverage(points);
      if (accepted(points)) return result;
    } catch (error) { observeFailure(error); }
  }
  if (provider.getPriceHistoryForResolutionWithMetadata || provider.getPriceHistoryForResolution) {
    try {
      const result = (await fetchHistoryResult(provider, source.instrument.symbol, source.instrument.exchange ?? "",
        { kind: "resolution", range: request.fallbackRange, resolution: request.resolution }, context))!;
      const { points } = result;
      observeCoverage(points);
      if (accepted(points)) {
        rememberParsedPriceHistory(parsedPriceHistoryKey(source.instrument, request.fallbackRange, request.resolution), points, result);
        return result;
      }
    } catch (error) { observeFailure(error); }
  }

  // Only original source/cache exhaustion reaches recovery. Ask the selected
  // source for its retained window; a nominal clock multiplier cannot guarantee
  // enough observations across exchange closures for a study's warmup.
  const retainedFailure = retentionError as HistoryRetentionError | null;
  let recoveryAttempted = false;
  const retryAt = retainedFailure ? retainedFailure.retention.observedAt + HISTORY_RETENTION_MAX_AGE_MS : undefined;
  if (retainedFailure && !coverageNotice && (provider.getDetailedPriceHistoryWithMetadata || provider.getDetailedPriceHistory)) {
    const step = CHART_RESOLUTION_STEP_MS[request.resolution];
    const target = publicListingTarget(source.instrument.symbol, source.instrument.exchange);
    const candidate = recoveryCandidates(retainedFailure, provider, source).map((value) => parseHistoryRecoveryCandidate(value))
      .find((value) => value && value.request.symbol === target.symbol
        && value.request.exchange === (target.exchange ?? "")
        && value.request.interval === canonicalHistoryInterval(request.resolution)
        && value.request.entityKey === getRouterEntityKey(source.instrument.symbol, context.instrument)
        && value.request.brokerId === context.brokerId && value.request.brokerInstanceId === context.brokerInstanceId);
    if (candidate && request.visibleBounds.start !== null) {
      // One complete bar inside the advancing source limit absorbs acquisition
      // latency. Keep the source's original exclusive end at its second precision.
      const start = Math.ceil(candidate.retention.availableStart / step) * step + step;
      const end = candidate.retention.requestedEnd;
      const visibleEnd = request.visibleBounds.end === null ? end : Math.floor(request.visibleBounds.end / 1000) * 1000;
      if (request.visibleBounds.start >= start && visibleEnd <= end && start < end) {
        recoveryAttempted = true;
        try {
          const result = (await fetchHistoryResult(provider, source.instrument.symbol, source.instrument.exchange ?? "",
            { kind: "detail", start: new Date(start), end: new Date(end), interval: request.resolution }, { ...context, historyRecovery: candidate }))!;
          const { points } = result;
          observeCoverage(points);
          if (accepted(points)) return { ...result, expiresAt: retryAt,
            recovery: { sourceKey: candidate.sourceKey, start, end, requiredWarmupPoints: request.requiredWarmupPoints,
              usableWarmupPoints: retainedWarmup(points, request.visibleBounds.start) } };
        } catch (error) { observeFailure(error); }
      }
    }
  }

  const unavailable = () => coverageNotice
    ?? `Requested ${request.resolution} price history is unavailable for ${instrumentLabel(source)}. Choose Auto or a supported interval.`;
  const fail = (message: string): never => {
    if (retryAt !== undefined) throw new PriceHistoryAcquisitionError(message, retryAt);
    throw new Error(message);
  };
  if (!request.allowProviderDefaultFallback || recoveryAttempted) return fail(unavailable());

  // After a proved retention failure, one explicit calendar fallback can retain
  // the familiar broader chart with known cadence. Never substitute coarser bars
  // for an authored financial/market period that requires finer observations.
  const coarser = retainedFailure && (provider.getPriceHistoryForResolutionWithMetadata || provider.getPriceHistoryForResolution)
    ? (["1d", "1wk", "1mo"] as const).find((resolution) =>
      CHART_RESOLUTION_STEP_MS[resolution] > CHART_RESOLUTION_STEP_MS[request.resolution]
      && isResolutionFineEnoughForMarketPeriod(resolution, source.period)
      && request.support.some((entry) => entry.resolution === resolution
        && TIME_RANGE_ORDER.indexOf(entry.maxRange) >= TIME_RANGE_ORDER.indexOf(request.fallbackRange))) : undefined;
  if (coarser) {
    try {
      const result = (await fetchHistoryResult(provider, source.instrument.symbol, source.instrument.exchange ?? "",
        { kind: "resolution", range: request.fallbackRange, resolution: coarser }, context))!;
      const { points } = result;
      observeCoverage(points);
      if (accepted(points)) {
        rememberParsedPriceHistory(parsedPriceHistoryKey(source.instrument, request.fallbackRange, coarser), points, result);
        return { ...result, expiresAt: retryAt };
      }
    } catch (error) { observeFailure(error); }
    return fail(unavailable());
  }
  if (retainedFailure) return fail(unavailable());
  if (!provider.getPriceHistoryWithMetadata && source.period && source.period !== "auto" && isMarketFieldId(source.fieldId)) return fail(unavailable());
  let result: PriceHistoryResult;
  try {
    result = (await fetchHistoryResult(provider, source.instrument.symbol, source.instrument.exchange ?? "",
      { kind: "range", range: request.fallbackRange }, context))!;
    if (source.period && source.period !== "auto" && isMarketFieldId(source.fieldId)
      && (result.resolution === null || !isResolutionFineEnoughForMarketPeriod(result.resolution, source.period))) return fail(unavailable());
  } catch (error) {
    return fail(coverageNotice ?? (error instanceof Error ? error.message : String(error)));
  }
  const { points } = result;
  observeCoverage(points);
  if (points.length === 0 && coverageNotice) return fail(coverageNotice);
  if (request.explicitWindow && points.length > 0 && !historyIntersectsBounds(points, request.visibleBounds)) {
    return fail(coverageNotice ?? `Price history for the requested window is unavailable for ${instrumentLabel(source)}.`);
  }
  // A default-only provider remains usable, but its bare array cannot establish
  // an interval for live-bar merging, annualization or a requested-cadence cache.
  return { ...result, expiresAt: retryAt ?? Date.now() + HISTORY_RETENTION_MAX_AGE_MS };
}

function baseSecuritySeries(
  spec: ChartSeriesSpec,
  financials: TickerFinancials,
  index: number,
  marketResolution?: ManualChartResolution | null,
  quoteMetadata: QuoteMetadata | null | undefined = financials.quoteMetadata,
): ResolvedSeries | null {
  if (spec.source.kind !== "security") return null;
  const field = getTimeSeriesField(spec.source.fieldId);
  if (!field) return null;
  const points = extractSecuritySeries(financials, spec.source);
  const symbol = instrumentLabel(spec.source);
  const statementCurrency = field.id.startsWith("fundamental.") && field.unit.startsWith("currency")
    ? reportingCurrencySeries(points, financials.financialCurrency) : null;
  const currency = statementCurrency ? statementCurrency.currency : financials.quote?.currency || quoteMetadata?.currency;
  const assetKind = resolveAssetDisplayKind({ assetCategory: financials.quote?.instrumentType || quoteMetadata?.instrumentType });
  const unknownBondBasis = hasUnknownBondHistoryBasis(financials.quote,
    spec.source.instrument.instrument?.secType, quoteMetadata?.instrumentType);
  const volumeUnit = unknownBondBasis ? undefined : assetKind === "equity" ? "shares" as const : assetKind === "contract" ? "contracts" as const : undefined;
  // A price quote establishes its currency, but only instrument metadata can
  // establish a per-share or per-crypto-unit basis. This does not establish the
  // provider's volume denomination or a derivative's contract multiplier.
  const unitTemplate = field.unitGroup === "price" && isMarketFieldId(field.id)
    ? unknownBondBasis ? "unknown" : `currency${assetKind === "equity" ? "/share" : assetKind === "crypto" ? "/unit" : ""}`
    : field.unit;
  const unit = field.id === "market.volume" ? volumeUnit ?? ""
    : unitTemplate.startsWith("currency") && currency ? unitTemplate.replace("currency", currency) : unitTemplate;
  const currencyUnitGroup = unknownBondBasis && field.unitGroup === "price" ? "price:unknown"
    : field.unit.startsWith("currency") && currency
    ? `${field.unitGroup}:${currency}`
    : field.unitGroup;
  const marketExchange = spec.source.instrument.exchange
    || financials.quote?.listingExchangeName
    || financials.quote?.exchangeName;
  const marketField = isMarketFieldId(spec.source.fieldId);
  const marketTimeZone = marketField
    && canonicalExchange(marketExchange) !== "CCC"
    ? resolveExchangeTimeZone(marketExchange)
    : null;
  const latestChangePercent = marketField && field.unit.startsWith("currency")
    && !unknownBondBasis
    && financials.quote && hasValidQuoteObservationTime(financials.quote)
    ? financials.quote.changePercent
    : undefined;
  const priceIssues = valuationPriceIssues(financials, spec.source);
  return {
    id: spec.id,
    label: spec.label?.trim() || `${symbol} ${field.shortLabel}`,
    color: spec.color ?? SERIES_COLORS[index % SERIES_COLORS.length]!,
    unit,
    unitGroup: currencyUnitGroup,
    priceAssetCategory: marketField && field.unitGroup === "price" && !unknownBondBasis
      ? financials.quote?.instrumentType || quoteMetadata?.instrumentType : undefined,
    volumeUnit,
    ...(priceIssues.length ? { valuationPriceIssues: priceIssues } : {}),
    warning: field.id === "market.volume" && !volumeUnit && points.length > 0
      ? "Volume unit unknown." : statementCurrency?.warning ?? valuationCurrencyWarning(financials, spec.source),
    nativeFrequency: marketField ? marketSeriesFrequency(spec.source, marketResolution)
      : spec.source.period && spec.source.period !== "auto" ? spec.source.period : field.nativeFrequency,
    ...(marketField ? { historyResolution: marketResolution } : {}),
    timestampMode: spec.source.timestampMode,
    dataShape: field.dataShape,
    style: spec.style,
    transform: spec.transform,
    axis: spec.axis === "right" ? "right" : "left",
    panelId: spec.panelId,
    interpolation: spec.interpolation,
    observationKind: marketField ? "market" : undefined,
    timeBasis: marketTimeZone
      ? {
          kind: "market",
          timeZone: marketTimeZone,
          cadenceMs: marketResolution
            ? CHART_RESOLUTION_STEP_MS[marketResolution]
            : undefined,
        }
      : undefined,
    latestChangePercent: typeof latestChangePercent === "number" && Number.isFinite(latestChangePercent)
      ? latestChangePercent
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

function baseCapabilitySeries(
  spec: ChartSeriesSpec,
  loaded: ResolvedSeries,
  index: number,
): ResolvedSeries {
  const points = loaded.points.flatMap((point) => {
    const date = finiteDate(point.date as unknown as string | Date | undefined);
    const observedAt = finiteDate(point.observedAt as unknown as string | Date | undefined) ?? date;
    const availableAt = finiteDate(point.availableAt as unknown as string | Date | undefined) ?? undefined;
    return date && observedAt ? [{ ...point, date, observedAt, ...(availableAt ? { availableAt } : {}) }] : [];
  });
  return {
    ...loaded,
    id: spec.id,
    label: spec.label?.trim() || loaded.label || (spec.source.kind === "capability" ? spec.source.seriesId : spec.id),
    color: spec.color ?? loaded.color ?? SERIES_COLORS[index % SERIES_COLORS.length]!,
    style: spec.style,
    transform: spec.transform,
    axis: spec.axis === "right" ? "right" : spec.axis === "left" ? "left" : loaded.axis,
    panelId: spec.panelId,
    interpolation: spec.interpolation,
    points,
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

function presentationBounds(
  series: ResolvedSeries,
  studies: readonly ChartSpec["studies"][number][],
  comparison: PriceComparison | null,
  fallback: DateBounds,
): DateBounds {
  const study = studyForOutput(series.id, studies);
  const sourceId = study && (study.kind === "sma" || study.kind === "ema" || study.kind === "bollinger")
    ? study.inputSeriesIds[0] : series.id;
  return (sourceId && comparison?.sourceBounds?.[sourceId]) || fallback;
}

function applyStudyPresentationTransforms(
  outputs: ResolvedSeries[],
  studies: readonly ChartSpec["studies"][number][],
  rawSeries: readonly ResolvedSeries[],
  visibleBounds: DateBounds,
  fallbackBaselineBounds?: DateBounds,
  priceComparison?: PriceComparison | null,
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
      ? scalarBaseline(input, priceComparisonBoundsForSeries(input, priceComparison ?? null) ?? visibleBounds)
        ?? (fallbackBaselineBounds ? scalarBaseline(input, fallbackBaselineBounds) : null)
      : undefined;
    const transformed = applyResolvedSeriesTransform(output, input.transform, { baseline });
    const inputBounds = priceComparison?.sourceBounds?.[input.id];
    return inputBounds ? { ...transformed, points: filterPoints(transformed.points, inputBounds) } : transformed;
  });
}

export async function resolveChartSpecData(
  spec: ChartSpec,
  sources: ChartResolveSources,
  cache = new ChartResolveCache(),
  options: ChartResolveOptions = {},
): Promise<ChartResolutionResult> {
  const errors: string[] = [];
  const warnings: string[] = spec.series.some((entry) => entry.visible !== false
    && entry.source.kind === "security" && isFundamentalFieldId(entry.source.fieldId))
    ? [FINANCIAL_VINTAGE_NOTICE] : [];
  const priorityWarnings: string[] = [];
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
        .catch(() => { cache.financialsByInstrument.delete(key); return null; });
      cache.financialsByInstrument.set(key, pending);
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
        .catch(() => { cache.quoteMetadataByInstrument.delete(key); return null; });
      cache.quoteMetadataByInstrument.set(key, pending);
    }
    return pending;
  };
  // True when a price-only chart painted with the placeholder list because the
  // real one had not answered yet. The placeholder must not narrow Auto's
  // choices: it is Yahoo-shaped and omits 1m and 30m that other sources serve.
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
          .catch(() => [] as ChartResolutionSupport[]);
        const settledPending = pending;
        settledPending.then((settled) => {
          if (cache.resolutionSupportByInstrument.get(key) === settledPending) cache.settledResolutionSupport.set(key, settled);
        });
      }
      cache.resolutionSupportByInstrument.set(key, pending);
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
  const sharedSupport = activeMarketSources.length > 0
    ? intersectChartResolutionSupport(await Promise.all(
        resolutionSupportSources.map((source) => loadResolutionSupport(source, priceOnly)),
      ))
    : [];
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
    const support = await loadResolutionSupport(source, priceOnly);
    const maxRange = getSupportMaxRange(support, initialResolution);
    const historyBounds = clampHistoryBoundsToSupport(initialCalculationBounds, maxRange,
      rangeDurationBounds(spec, initialCalculationBounds).end);
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
      support,
      requiredWarmupPoints: maxStudyWarmupPoints(spec.studies),
    };
    const key = [
      instrumentKey(source),
      request.resolution,
      request.fallbackRange,
      request.allowProviderDefaultFallback ? "auto" : "manual",
      isMarketFieldId(source.fieldId) ? source.period ?? "auto" : "auto",
      ...(request.explicitWindow
        ? [request.bounds.start ?? "open", request.bounds.end ?? "open"]
        : []),
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
    let loaded = await pending;
    const now = () => referenceNow.getTime() + Math.max(0, Date.now() - resolutionStartedAt);
    const currentWindow = () => !request.explicitWindow
      || (request.bounds.end !== null && now() - (request.bounds.end + 1) < 60 * 60_000);
    const staleCurrent = (value: LoadedPriceHistory) => currentWindow() && !!value.session
      && isPriceHistoryStaleForCurrentWindow(value.points, now(), {
        exchange: source.instrument.exchange, session: value.session,
        ...(value.resolution ? { intervalMs: CHART_RESOLUTION_STEP_MS[value.resolution] } : {}),
      });
    if (staleCurrent(loaded)) {
      if (reused && (cache.priceHistoryRefreshAfter.get(key) ?? 0) <= Date.now()) {
        // Claim the refresh before awaiting it so price/volume/studies share one attempt.
        cache.priceHistoryRefreshAfter.set(key, Date.now() + 30_000);
        if (cache.priceHistoryByRequest.get(key) === pending) pending = acquire();
        else pending = cache.priceHistoryByRequest.get(key)!;
        loaded = await pending;
      } else if (cache.priceHistoryByRequest.get(key) !== pending) {
        loaded = await cache.priceHistoryByRequest.get(key)!;
      }
      if (staleCurrent(loaded)) {
        const previousDeadline = cache.priceHistoryRefreshAfter.get(key) ?? 0;
        const retryAt = previousDeadline > Date.now() ? previousDeadline : Date.now() + 30_000;
        cache.priceHistoryRefreshAfter.set(key, retryAt);
        throw new PriceHistoryAcquisitionError(`Current price history is unavailable for ${instrumentLabel(source)}.`, retryAt);
      }
    }
    cache.priceHistoryRefreshAfter.delete(key);
    const history = loaded.points;
    const coverageNotice = isShellLondonTarget(source.instrument.symbol, source.instrument.exchange)
      ? historyCoverageNotice(history, request.visibleBounds.start) : null;
    if (coverageNotice) priorityWarnings.push(coverageNotice);
    // Only proven equal cadences can share an accumulated observation window.
    // An opaque default result stays attached to its original acquisition.
    const accumulationKey = loaded.resolution === null ? null : `${instrumentKey(source)}|${loaded.resolution}|${priceHistoryAcquisitionIdentity(loaded)}`;
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
    const accumulated = loaded.resolution === null ? history : mergePriceHistoryWindows(
      previousHistory, history, loaded.resolution,
    );
    const tail = priceHistoryTailAcquisition(previous, loaded);
    const combined = { ...loaded, session: tail.session, sourceKey: tail.sourceKey, points: accumulated };
    if (accumulationKey) cache.accumulatedPriceHistory.set(accumulationKey, combined);
    return { ...combined, requestKey: key,
      ...(loaded.recovery ? { recovery: { ...loaded.recovery,
        requiredWarmupPoints: request.requiredWarmupPoints,
        usableWarmupPoints: retainedWarmup(accumulated, request.visibleBounds.start),
      } } : {}),
    };
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
        const capabilityViewport: ChartSpec["viewport"] = {
          ...spec.viewport,
          ...(requestVisibleBounds.start !== null && requestVisibleBounds.end !== null
            ? {
                dateWindow: {
                  start: new Date(requestVisibleBounds.start).toISOString(),
                  end: new Date(requestVisibleBounds.end).toISOString(),
                },
              }
            : {}),
        };
        const key = chartSeriesSourceKey(seriesSpec.source, capabilityViewport);
        let pending = cache.capabilitySeriesByRequest.get(key);
        if (!pending) {
          pending = sources.resolveCapabilitySeries(seriesSpec.source, capabilityViewport, seriesSpec);
          cache.capabilitySeriesByRequest.set(key, pending);
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
      if (forwardPE && financials?.epsEstimates && !history) {
        history = await loadHistory(resolvedSource, true).catch((error: unknown) => {
          warnings.push(`${seriesSpec.label ?? seriesSpec.id}: ${error instanceof Error ? error.message : String(error)}`);
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
      if (history) {
        // Classification must be available before combining observations. A
        // quote cannot establish the price basis of independent bond history.
        // Comparison endpoints also retain source history: a streamed quote
        // could otherwise update only one leg within a shared weekly bar.
        merged = { ...mergeHistory(merged, history.points, undefined, observationNow,
          liveBarResolution ?? undefined, resolvedSource.instrument.exchange,
          liveBarResolution != null && !comparedSeriesIds.has(seriesSpec.id), resolvedSource.instrument.instrument?.secType),
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
      );
      if (!result) throw new Error(`Unknown field ${source.fieldId}.`);
      if (realizedVolInputs.has(seriesSpec.id)) {
        const historicalResult = baseSecuritySeries(resolvedSpec, historical, index, history?.resolution, quoteMetadata);
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
      errors.push(`${seriesSpec.label ?? seriesSpec.id}: ${message}`);
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
  const bounds = hasExplicitWindow
    ? requestVisibleBounds
    : followLatestMarketObservation(initialVisibleBounds, rawSeries);
  const servedCadences = new Set(rawSeries.filter((entry) => entry.observationKind === "market" && entry.points.length > 0)
    .map((entry) => entry.historyResolution));
  const commonCadence = servedCadences.size === 1 ? [...servedCadences][0] : undefined;
  const resolution = commonCadence ?? undefined;
  const comparisonResolution = resolution ?? "auto";
  const priceComparison = resolvePriceComparison(spec, rawSeries, bounds, comparisonResolution, requestBounds ? null : spec.viewport.dateWindow);
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
      ),
    ];
    warnings.push(...studyResult.warnings);
    errors.push(...studyResult.errors);
  }

  const bufferedSeries = assignAxes(resolved, [...spec.series, ...spec.studies], warnings)
    .map((entry) => clipPriceComparison(entry, priceComparison));
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
  const viewport = exposeViewport && displayBounds.start !== null && displayBounds.end !== null
    ? { start: new Date(displayBounds.start), end: new Date(displayBounds.end) }
    : undefined;
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
    viewport,
    resolution,
  };
}
