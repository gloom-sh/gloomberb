import { SnapshotHistoryUnavailableError } from "../market-data/snapshot-provider";
import { HistoryCoverageError, historyCoverageNotice } from "../sources/history-coverage";
import { notATickerSymbol, ProviderMissError } from "../sources/provider-errors";
import { indexRootSuggestion } from "../tickers/index-roots";
import {
  HISTORY_RETENTION_MAX_AGE_MS,
  canonicalHistoryInterval,
  isHistoryRetentionError,
  parseHistoryRecoveryCandidate,
  type HistoryRecoveryCandidate,
  type HistoryRetentionError,
} from "../sources/history-retention";
import { getRouterEntityKey } from "../sources/provider-router/cache";
import { publicListingTarget } from "../sources/listing-target";
import { fetchHistoryResult } from "../sources/history-result";
import type { PriceHistoryResult } from "../types/price-history";
import { subtractTimeRange } from "./date-window";
import {
  CHART_RESOLUTION_STEP_MS,
  isIntradayResolution,
  type ChartResolutionSupport,
  type ManualChartResolution,
} from "./resolution";
import { TIME_RANGES, type TimeRange } from "./range";
import type { DataProvider, MarketDataRequestContext } from "../types/data-provider";
import type { TickerFinancials } from "../types/financials";
import { isMarketFieldId } from "./field-catalog";
import { isResolutionFineEnoughForMarketPeriod } from "./market-resolution";
import { rememberParsedPriceHistory, parsedPriceHistoryKey } from "./parsed-history-cache";
import { getPricePointTimestamp } from "../utils/price-history";
import { timeZoneLabel, zonedDateKey, zonedWallClockMs } from "../utils/zoned-date-time";
import { formatShortDate } from "../utils/datetime-format";
import { listingTimeZone } from "../market-data/market/trading-sessions";
import type { ChartSeriesSpec } from "./types";
import { type LoadedPriceHistory, requestContext, instrumentLabel } from "./resolve-context";
import { type DateBounds, DAY_MS, exclusiveEnd } from "./chart-bounds";

export interface PriceHistoryRequest {
  bounds: DateBounds;
  visibleBounds: DateBounds;
  explicitWindow: boolean;
  /** Dates the chart was given, not a view the user panned or zoomed to. */
  authoredWindow: boolean;
  fallbackRange: TimeRange;
  resolution: ManualChartResolution;
  allowProviderDefaultFallback: boolean;
  support: readonly ChartResolutionSupport[];
  requiredWarmupPoints: number;
  historyRequestKey?: string;
  /** Ask for pre-market and after-hours bars. */
  historySession?: "extended";
}

export class PriceHistoryAcquisitionError extends Error {
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

/**
 * Shown while a current chart draws a saved copy that no refetch brought up
 * to date: the last saved bar on the venue's clock, as the axis reads it.
 */
export function behindHistoryNotice(
  source: Extract<ChartSeriesSpec["source"], { kind: "security" }>,
  points: TickerFinancials["priceHistory"],
  now: number,
): string | null {
  const latest = points.findLast((point) => Number.isFinite(point.close) && Number.isFinite(getPricePointTimestamp(point)));
  if (!latest) return null;
  const zone = listingTimeZone(source.instrument.symbol, source.instrument.exchange) ?? "UTC";
  const wall = new Date(zonedWallClockMs(getPricePointTimestamp(latest), zone)).toISOString();
  const sameYear = wall.slice(0, 4) === zonedDateKey(now, zone).slice(0, 4);
  const day = formatShortDate(wall.slice(0, 10), { utc: true, year: sameYear ? false : "numeric" });
  return `${instrumentLabel(source)}: newer bars are unavailable; showing saved bars as of ${day} ${wall.slice(11, 16)} ${timeZoneLabel(zone)}.`;
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

/** Two closes of one session further apart than this are on different split bases, not a revision. */
const SAME_BASIS_LIMIT = Math.log(1.4);

/**
 * Whether two windows of one history are on the same split basis: most of the
 * sessions both hold close within 40% of each other. A window acquired before
 * a split and one acquired after it hold the same sessions about the split's
 * ratio apart (NRDY's 18 Aug 2026 close, 0.654 before its 1-for-15 reverse
 * split and 9.81 after it), and merged they would draw that ratio as a move.
 * Windows that share no session cannot be told apart and agree.
 */
export function priceHistoryWindowsAgree(
  current: TickerFinancials["priceHistory"],
  incoming: TickerFinancials["priceHistory"],
  resolution: ManualChartResolution,
): boolean {
  if (current.length === 0 || incoming.length === 0) return true;
  // Daily and slower bars stamped differently by two sources are one session within this.
  const tolerance = isIntradayResolution(resolution) ? 0 : CHART_RESOLUTION_STEP_MS[resolution] * 0.8;
  const closes = current
    .map((point) => ({ time: getPricePointTimestamp(point), close: point.close }))
    .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.close) && point.close > 0)
    .sort((left, right) => left.time - right.time);
  let same = 0;
  let other = 0;
  for (const point of incoming) {
    const time = getPricePointTimestamp(point);
    if (!Number.isFinite(time) || !Number.isFinite(point.close) || !(point.close > 0)) continue;
    let low = 0;
    let high = closes.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (closes[middle]!.time < time) low = middle + 1;
      else high = middle;
    }
    const nearest = [closes[low - 1], closes[low]]
      .filter((candidate) => candidate && Math.abs(candidate.time - time) <= tolerance)
      .sort((left, right) => Math.abs(left!.time - time) - Math.abs(right!.time - time))[0];
    if (!nearest) continue;
    if (Math.abs(Math.log(point.close / nearest.close)) > SAME_BASIS_LIMIT) other += 1;
    else same += 1;
  }
  return other <= same;
}

export function mergePriceHistoryWindows(
  current: TickerFinancials["priceHistory"],
  incoming: TickerFinancials["priceHistory"],
  resolution: ManualChartResolution,
): TickerFinancials["priceHistory"] {
  // A window on another split basis than the incoming one is dropped, never merged into it.
  if (!priceHistoryWindowsAgree(current, incoming, resolution)) current = [];
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
    // An intraday point strictly inside a later window's bar is that window's
    // earlier observation of it, such as a trade-time final print.
    const step = isIntradayResolution(resolution) ? CHART_RESOLUTION_STEP_MS[resolution] : 0;
    let coveredUntil = Number.NEGATIVE_INFINITY;
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
        if (!(incomingPoint && currentTimestamp < incomingTimestamp && currentTimestamp < coveredUntil)) {
          append(currentPoint, currentTimestamp);
        }
        currentIndex += 1;
      } else if (incomingPoint) {
        append(incomingPoint, incomingTimestamp);
        if (step) coveredUntil = incomingTimestamp + step;
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

export function historyIntersectsBounds(
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

export function clampHistoryBoundsToSupport(
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

export function retainedWarmup(points: TickerFinancials["priceHistory"], visibleStart: number | null): number {
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

/** Requests for older bars one panned window may add when its source answers only the newest part. */
const OLDER_BAR_REQUESTS = 3;
/** A window may start this far before its first bar for closed sessions alone: weekends and holiday weeks. */
const CLOSED_SESSION_GAP_MS = 10 * DAY_MS;
/**
 * An answer cut short at the source's cap holds thousands of bars. A shorter
 * one that starts late is a young listing or a source that keeps less: it
 * holds all there is, and an older request cannot change that.
 */
const CAPPED_ANSWER_MIN_BARS = 1_000;

function firstBarTime(points: TickerFinancials["priceHistory"]): number {
  for (const point of points) {
    const time = getPricePointTimestamp(point);
    if (Number.isFinite(time) && Number.isFinite(point.close)) return time;
  }
  return Number.NaN;
}

/**
 * A source caps the bars one request returns and answers with the newest, so
 * a panned window can come back starting weeks after it was asked to. The
 * older part is asked for on its own, from the same source and session, until
 * it is covered or the source has nothing older: then the first bar is where
 * this listing's history at this cadence starts, and the chart stops there
 * instead of asking again. So does an answer that starts late without being
 * cut short, or one the source says its coverage starts with.
 */
async function withOlderBars(
  provider: DataProvider,
  source: Extract<ChartSeriesSpec["source"], { kind: "security" }>,
  request: PriceHistoryRequest,
  result: PriceHistoryResult,
  context: MarketDataRequestContext,
): Promise<LoadedPriceHistory> {
  const start = request.bounds.start;
  const end = request.bounds.end;
  if (start === null || end === null || result.resolution !== request.resolution) return result;
  const toleranceMs = Math.max(CLOSED_SESSION_GAP_MS, (end - start) / 5);
  let current: LoadedPriceHistory = result;
  let answerBars = result.points.length;
  for (let attempt = 0; attempt < OLDER_BAR_REQUESTS; attempt += 1) {
    const first = firstBarTime(current.points);
    if (!Number.isFinite(first) || first - start <= toleranceMs) return current;
    // An answer short of the cap that still starts late is everything the source has.
    if (answerBars < CAPPED_ANSWER_MIN_BARS || current.coverageStart) return { ...current, historyStart: first };
    let older: PriceHistoryResult | null;
    try {
      older = await fetchHistoryResult(provider, source.instrument.symbol, source.instrument.exchange ?? "",
        { kind: "detail", start: new Date(start), end: new Date(first), interval: request.resolution }, context);
    } catch (error) {
      // The source keeps nothing that old, by its own account; anything else may pass.
      return isHistoryRetentionError(error) || error instanceof ProviderMissError
        ? { ...current, historyStart: first } : current;
    }
    if (!older || older.resolution !== current.resolution
      || priceHistoryAcquisitionIdentity(older) !== priceHistoryAcquisitionIdentity(current)) return current;
    const earlier = older.points.filter((point) => getPricePointTimestamp(point) < first);
    if (!Number.isFinite(firstBarTime(earlier))) return { ...current, historyStart: first };
    current = { ...current, points: [...earlier, ...current.points] };
    answerBars = older.points.length;
  }
  return current;
}

/**
 * A failure that says no listing carries the symbol, offering the index a
 * bare root names: `Not a ticker: VIX. Did you mean ^VIX (Cboe Volatility
 * Index)?`. Null for any other failure.
 */
function notATickerText(error: unknown): string | null {
  const message = error instanceof Error ? error.message.split("\n")[0]! : "";
  const symbol = notATickerSymbol(message);
  if (!symbol) return null;
  const suggestion = message.includes(" Did you mean ") ? null : indexRootSuggestion(symbol);
  return suggestion ? `Not a ticker: ${symbol}. ${suggestion}` : message;
}

export async function loadPriceHistory(
  provider: DataProvider,
  source: Extract<ChartSeriesSpec["source"], { kind: "security" }>,
  request: PriceHistoryRequest,
): Promise<LoadedPriceHistory> {
  const context = { ...requestContext(source), historyRequestKey: request.historyRequestKey,
    ...(request.historySession ? { historySession: request.historySession } : {}) };
  let coverageNotice: string | null = null;
  let retentionError: HistoryRetentionError | null = null;
  // No source has a listing for the symbol: no bar size would help, so the failure says that instead.
  let notATicker: string | null = null;
  const observeFailure = (error: unknown) => {
    if (error instanceof SnapshotHistoryUnavailableError) throw error;
    if (error instanceof HistoryCoverageError) coverageNotice ??= error.message;
    if (isHistoryRetentionError(error)) retentionError ??= error;
    notATicker ??= notATickerText(error);
  };
  const observeCoverage = (result: PriceHistoryResult) => {
    coverageNotice ??= historyCoverageNotice(result.coverageStart, request.visibleBounds.start);
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
      observeCoverage(result);
      // Authored dates chart what their source answers; a panned view reaches for the rest.
      if (accepted(points)) return request.authoredWindow ? result : await withOlderBars(provider, source, request, result, context);
    } catch (error) { observeFailure(error); }
  }
  if (provider.getPriceHistoryForResolutionWithMetadata || provider.getPriceHistoryForResolution) {
    try {
      const result = (await fetchHistoryResult(provider, source.instrument.symbol, source.instrument.exchange ?? "",
        { kind: "resolution", range: request.fallbackRange, resolution: request.resolution }, context))!;
      const { points } = result;
      observeCoverage(result);
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
      // At an interval the user chose, a preset range or a panned or zoomed
      // view that reaches back past the retained bars, but still reaches them,
      // charts what the source keeps. Auto steps to coarser bars below instead,
      // and authored dates keep failing.
      const retainedOnly = !request.allowProviderDefaultFallback && !request.authoredWindow && visibleEnd >= start;
      if ((retainedOnly || request.visibleBounds.start >= start) && visibleEnd <= end && start < end) {
        recoveryAttempted = true;
        try {
          const result = (await fetchHistoryResult(provider, source.instrument.symbol, source.instrument.exchange ?? "",
            { kind: "detail", start: new Date(start), end: new Date(end), interval: request.resolution }, { ...context, historyRecovery: candidate }))!;
          const { points } = result;
          observeCoverage(result);
          if (accepted(points)) return { ...result, expiresAt: retryAt, historyStart: firstBarTime(points),
            recovery: { sourceKey: candidate.sourceKey, start, end, requiredWarmupPoints: request.requiredWarmupPoints,
              usableWarmupPoints: retainedWarmup(points, request.visibleBounds.start), retention: candidate.retention } };
        } catch (error) { observeFailure(error); }
      }
    }
  }

  const unavailable = () => coverageNotice ?? notATicker
    ?? `Requested ${request.resolution} price history is unavailable for ${instrumentLabel(source)}.`;
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
        && TIME_RANGES.indexOf(entry.maxRange) >= TIME_RANGES.indexOf(request.fallbackRange))) : undefined;
  if (coarser) {
    try {
      const result = (await fetchHistoryResult(provider, source.instrument.symbol, source.instrument.exchange ?? "",
        { kind: "resolution", range: request.fallbackRange, resolution: coarser }, context))!;
      const { points } = result;
      observeCoverage(result);
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
    return fail(coverageNotice ?? notATickerText(error) ?? (error instanceof Error ? error.message : String(error)));
  }
  const { points } = result;
  observeCoverage(result);
  if (points.length === 0 && coverageNotice) return fail(coverageNotice);
  if (request.explicitWindow && points.length > 0 && !historyIntersectsBounds(points, request.visibleBounds)) {
    return fail(coverageNotice ?? `Price history for the requested window is unavailable for ${instrumentLabel(source)}.`);
  }
  // A default-only provider remains usable, but its bare array cannot establish
  // an interval for live-bar merging, annualization or a requested-cadence cache.
  return { ...result, expiresAt: retryAt ?? Date.now() + HISTORY_RETENTION_MAX_AGE_MS };
}
