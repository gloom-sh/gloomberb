import { logFailure } from "../../../utils/log-failure";
import type { DataProvider, MarketDataRequestContext } from "../../../types/data-provider";
import type { PricePoint, Quote } from "../../../types/financials";
import type { TimeRange } from "../../../time-series/range";
import {
  getSupportedPresetResolution,
  isIntradayResolution,
  type ChartResolutionSupport,
  type ManualChartResolution,
} from "../../../time-series/resolution";
import { parsePublicTickerKey, resolveExchangeTimeZone } from "../../../utils/exchanges";
import { listingSuffixExchange } from "../../../sources/listing-symbols";
import { getPricePointTimestamp } from "../../../utils/price-history";
import { dateOptionError, readCalendarDate } from "../../../utils/calendar-date";
import { pricePointIntegrity } from "../../../utils/price-history-integrity";
import { zonedDateKey, zonedWallClockToUtcMs } from "../../../utils/zoned-date-time";
import { fetchHistoryResult } from "../../../sources/history-result";
import { historyRetentionNotice, isHistoryRetentionError, type HistoryRetention } from "../../../sources/history-retention";
import type { PriceHistoryResult } from "../../../types/price-history";
import { isRegularSessionTime, latestRegularSessionClose, regularSessionCloseOn } from "../../../market-data/market/freshness";
import { calendarBarStart, isUsCashListing } from "../../../time-series/chart-data";
import { newestSessionClose } from "../../../time-series/official-close";
import { quoteTradingDay } from "../../../market-data/quotes/day-range";

type IntradayRangePreset = "1D" | "1W";

export interface IntradayRequest {
  rangePreset: IntradayRangePreset;
  resolution: ManualChartResolution;
  session: string | null;
}

export interface IntradayWindow {
  points: PricePoint[];
  sessionDates: string[];
  start: Date | null;
  end: Date | null;
}

interface IntradayPriceDomainFailure {
  readonly reason: "nonpositive-price";
  readonly instrumentType: string | null;
  /** Rejected observations from the selected window or its calculation buffer. */
  readonly sourcePoints: ReadonlyArray<Readonly<Omit<PricePoint, "date"> & { date: string }>>;
}

export interface LoadedIntradayWindow extends IntradayWindow {
  bufferedPoints: PricePoint[];
  unavailableReason: string | null;
  quote?: Quote;
  priceDomainFailure?: IntradayPriceDomainFailure;
  session?: PriceHistoryResult["session"];
  sourceKey?: string;
}

export async function historicalIntradayClose(
  provider: DataProvider,
  window: Pick<LoadedIntradayWindow, "points" | "sourceKey" | "quote"> & { symbol: string; exchange: string },
  day: string,
  now: number,
  context?: MarketDataRequestContext,
): Promise<{ mark?: PricePoint; note: string; lastAt: number } | null> {
  const venue = window.exchange || window.quote?.listingExchangeName || window.quote?.exchangeName;
  if (!isUsCashListing(venue, window.quote?.instrumentType)) return null;
  const bell = regularSessionCloseOn(venue, day);
  const latest = latestRegularSessionClose(venue, now);
  if (bell === null || !latest || day > latest.date
    || (day === latest.date && (!window.quote || quoteTradingDay(window.quote) === day))) return null;
  const last = window.points.findLast((point) => {
    const time = getPricePointTimestamp(point);
    return Number.isFinite(time) && time < bell && calendarBarStart(time, "1d", venue) === day
      && isRegularSessionTime(venue, time) === true && !pricePointIntegrity(point);
  });
  if (!last) return null;
  const lastAt = getPricePointTimestamp(last);
  const unavailable = { lastAt, note: `${window.symbol}: last regular print ${new Date(lastAt).toISOString().slice(11, 16)} UTC; official close unavailable.` };
  if (!window.sourceKey) return unavailable;
  const daily = await fetchHistoryResult(provider, window.symbol, window.exchange, {
    kind: "detail", interval: "1d", start: new Date(`${day}T00:00:00Z`), end: new Date(`${day}T23:59:59.999Z`),
  }, context).catch(logFailure("chart-composer.session-history", "Read the dated session close failed", null));
  if (!daily || daily.sourceKey !== window.sourceKey || daily.savedCopyBehind || daily.extendedHours) return unavailable;
  const onDay = daily.points.filter((point) => {
    const time = getPricePointTimestamp(point);
    return Number.isFinite(time) && calendarBarStart(time, "1d", venue) === day;
  });
  const bar = onDay.length === 1 ? onDay[0] : undefined;
  if (!bar || bar.partial || bar.unsettled || bar.filled || bar.beforeClose || bar.closeCopied || bar.closeRebuilt
    || bar.rescaled || pricePointIntegrity(bar) || (bar.low != null && last.close < bar.low) || (bar.high != null && last.close > bar.high)) return unavailable;
  const close = newestSessionClose(null, { date: day, venue, lastTrade: last.close, dailyClose: bar.close });
  if (!close || !("close" in close)) return unavailable;
  const date = new Date(bell);
  return { lastAt, mark: { date, close: close.close, sessionClose: true },
    note: `${window.symbol}: official close ${date.toISOString().slice(11, 16)} UTC; separate from the minute bars.` };
}

const HISTORICAL_RETRY_DELAY_MS = 61 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** `--session` as YYYY-MM-DD: any date a date option reads, or an error that lists the formats. */
function readSessionDate(value: string): string {
  const date = readCalendarDate(value);
  if (!date) throw new Error(`Invalid --session value "${value}". ${dateOptionError(value, "--session", { subject: "a session date" })}`);
  return date;
}

function parseSessionDate(value: string): {
  year: number;
  month: number;
  day: number;
} {
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return { year, month, day };
}

function sessionUtcBounds(value: string, timeZone: string): {
  start: Date;
  end: Date;
} {
  const parsed = parseSessionDate(value);
  const next = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + 1));
  return {
    start: new Date(zonedWallClockToUtcMs(
      timeZone,
      parsed.year,
      parsed.month,
      parsed.day,
      0,
      0,
      0,
    )),
    end: new Date(zonedWallClockToUtcMs(
      timeZone,
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      next.getUTCDate(),
      0,
      0,
      0,
    )),
  };
}

/**
 * The zone a listing's sessions are dated in: its exchange's, else the one its
 * key or listing suffix names (RMS.AX trades on the ASX). A session is the
 * bars of one local day, so it starts at the local open even where that falls
 * before UTC midnight (10:00 in Sydney is 23:00 UTC the day before). UTC for a
 * listing without a known venue, such as a bare US symbol.
 */
export function intradaySessionTimeZone(symbol: string, exchange: string | undefined): string {
  const parsed = parsePublicTickerKey(symbol);
  return resolveExchangeTimeZone(exchange)
    ?? resolveExchangeTimeZone(parsed.exchange ?? listingSuffixExchange(parsed.symbol))
    ?? "UTC";
}

function normalizedPoints(points: readonly PricePoint[]): PricePoint[] {
  const byTimestamp = new Map<number, PricePoint>();
  for (const point of points) {
    const timestamp = getPricePointTimestamp(point);
    // Session selection is independent of the asset's price domain. In
    // particular, a zero/negative futures close is still an observation.
    if (!Number.isFinite(timestamp) || (!Number.isFinite(point.close) && !pricePointIntegrity(point))) continue;
    byTimestamp.set(timestamp, {
      ...point,
      date: point.date instanceof Date ? point.date : new Date(timestamp),
    });
  }
  return [...byTimestamp.values()].sort(
    (left, right) => getPricePointTimestamp(left) - getPricePointTimestamp(right),
  );
}

export function intradaySessionDates(points: readonly PricePoint[], timeZone: string): string[] {
  return [...new Set(normalizedPoints(points).map((point) => zonedDateKey(getPricePointTimestamp(point), timeZone)))];
}

function resolveIntradaySessionWindow(
  points: readonly PricePoint[],
  options: {
    rangePreset: IntradayRangePreset;
    session?: string | null;
    timeZone?: string | null;
  },
): IntradayWindow {
  const timeZone = options.timeZone || "UTC";
  const normalized = normalizedPoints(points);
  const bySession = new Map<string, PricePoint[]>();
  for (const point of normalized) {
    const date = zonedDateKey(getPricePointTimestamp(point), timeZone);
    const sessionPoints = bySession.get(date) ?? [];
    sessionPoints.push(point);
    bySession.set(date, sessionPoints);
  }

  const requestedSession = options.session?.trim() ? readSessionDate(options.session.trim()) : null;
  const availableSessions = [...bySession.keys()].sort();
  const selectedSessions = requestedSession
    ? availableSessions.filter((date) => date === requestedSession)
    : options.rangePreset === "1D"
      ? availableSessions.slice(-1)
      : availableSessions.slice(-5);
  const selected = selectedSessions.flatMap((date) => bySession.get(date) ?? []);
  const startTime = selected.length > 0 ? getPricePointTimestamp(selected[0]!) : Number.NaN;
  const endTime = selected.length > 0 ? getPricePointTimestamp(selected.at(-1)!) : Number.NaN;
  return {
    points: selected,
    sessionDates: selectedSessions,
    start: Number.isFinite(startTime) ? new Date(startTime) : null,
    end: Number.isFinite(endTime) ? new Date(endTime) : null,
  };
}

function hasIntradayBars(window: IntradayWindow, timeZone = "UTC"): boolean {
  if (window.points.length < 2) return false;
  const pointsBySession = new Map<string, number[]>();
  for (const point of window.points) {
    const timestamp = getPricePointTimestamp(point);
    const date = zonedDateKey(timestamp, timeZone);
    const timestamps = pointsBySession.get(date) ?? [];
    timestamps.push(timestamp);
    pointsBySession.set(date, timestamps);
  }
  return [...pointsBySession.values()].some((timestamps) => (
    timestamps.length >= 2
    && timestamps.some((timestamp, index) => index > 0 && timestamp - timestamps[index - 1]! < DAY_MS)
  ));
}

export function resolveIntradayRequest(options: {
  rangePreset?: unknown;
  chartResolution?: unknown;
  session?: unknown;
  /** Intervals the sources serve; Auto steps down from 1m when it is missing. */
  support?: readonly ChartResolutionSupport[];
}): IntradayRequest {
  const session = typeof options.session === "string" && options.session.trim()
    ? readSessionDate(options.session.trim())
    : null;
  const rangePreset = session
    ? "1D"
    : options.rangePreset === "1W" ? "1W" : "1D";
  const requestedResolution = typeof options.chartResolution === "string"
    ? options.chartResolution
    : "auto";
  const resolution = requestedResolution === "auto"
    ? getSupportedPresetResolution(rangePreset, options.support ?? [])
    : requestedResolution as ManualChartResolution;
  if (!isIntradayResolution(resolution)) {
    throw new Error(`GIP requires an intraday chart resolution, got "${requestedResolution}".`);
  }
  return { rangePreset, resolution, session };
}

function unavailableReason(symbol: string, request: IntradayRequest, kind: "empty" | "not-intraday" | "failed", retention?: HistoryRetention, timeZone: string | null = null): string {
  const window = request.session
    ? `session ${request.session}`
    : request.rangePreset === "1W" ? "the latest five sessions" : "the latest session";
  // A session older than the source keeps at the resolution: how far back it goes, and where that day's prices are.
  if (retention && request.session) {
    return `${historyRetentionNotice(retention, request.resolution, timeZone)} That session's daily bar: gloom history ${symbol} --from ${request.session} --to ${request.session}.`;
  }
  if (kind === "failed") return `Intraday history request failed for ${symbol}. Try again.`;
  return kind === "not-intraday"
    ? `The market-data provider did not return intraday bars for ${symbol} for ${window}.`
    : `No intraday price history is available for ${symbol} for ${window}.`;
}

interface IntradayHistoryAttempt extends PriceHistoryResult {
  requestFailed?: true;
  /** The session asked for is older than the source keeps at the resolution. */
  retention?: HistoryRetention;
}

async function loadTrailingHistory(
  provider: DataProvider,
  symbol: string,
  exchange: string,
  request: IntradayRequest,
  context?: MarketDataRequestContext,
): Promise<IntradayHistoryAttempt> {
  const fetchRange: TimeRange = request.rangePreset === "1W" && request.resolution !== "1m"
    ? "1M"
    : "1W";
  try {
    return await fetchHistoryResult(provider, symbol, exchange,
      { kind: "resolution", range: fetchRange, resolution: request.resolution }, context)
      ?? { points: [], resolution: request.resolution };
  } catch (error) {
    logFailure("chart-composer.session-history", "Load trailing intraday history failed")(error);
    return { points: [], resolution: request.resolution, requestFailed: true };
  }
}

async function loadHistoricalFallback(
  provider: DataProvider,
  symbol: string,
  exchange: string,
  request: IntradayRequest,
  now: Date,
  timeZone: string,
  context?: MarketDataRequestContext,
): Promise<IntradayHistoryAttempt> {
  const empty = { points: [], resolution: request.resolution };
  const failed: IntradayHistoryAttempt = { ...empty, requestFailed: true };
  if (request.session) {
    const bounds = sessionUtcBounds(request.session, timeZone);
    return await fetchHistoryResult(provider, symbol, exchange,
      { kind: "detail", start: bounds.start, end: bounds.end, interval: request.resolution }, context).catch((error: unknown) => (
      isHistoryRetentionError(error) ? { ...empty, retention: error.retention }
        : logFailure("chart-composer.session-history", "Load requested intraday session failed", failed)(error))) ?? empty;
  }
  const end = new Date(now.getTime() - HISTORICAL_RETRY_DELAY_MS);
  const lookbackDays = request.rangePreset === "1W" ? 35 : 8;
  const start = new Date(end.getTime() - lookbackDays * DAY_MS);
  return await fetchHistoryResult(provider, symbol, exchange,
    { kind: "detail", start, end, interval: request.resolution }, context).catch(logFailure("chart-composer.session-history", "Load historical intraday fallback failed", failed)) ?? empty;
}

export async function loadIntradayWindow(options: {
  provider: DataProvider;
  symbol: string;
  exchange: string;
  request: IntradayRequest;
  now?: Date;
  context?: MarketDataRequestContext;
}): Promise<LoadedIntradayWindow> {
  const timeZone = intradaySessionTimeZone(options.symbol, options.exchange);
  let acquisition = options.request.session
    ? await loadHistoricalFallback(
        options.provider,
        options.symbol,
        options.exchange,
        options.request,
        options.now ?? new Date(), timeZone, options.context,
      )
    : await loadTrailingHistory(
        options.provider,
        options.symbol,
        options.exchange,
        options.request, options.context,
      );
  let requestFailed = acquisition.requestFailed === true;
  const retention = acquisition.retention;
  let raw = acquisition.points;
  let window = resolveIntradaySessionWindow(raw, {
    rangePreset: options.request.rangePreset,
    session: options.request.session,
    timeZone,
  });
  let sawNonIntradayData = window.points.length > 0 && !hasIntradayBars(window, timeZone);

  if (!hasIntradayBars(window, timeZone)) {
    acquisition = options.request.session
      ? await loadTrailingHistory(
          options.provider,
          options.symbol,
          options.exchange,
          options.request, options.context,
        )
      : await loadHistoricalFallback(
          options.provider,
          options.symbol,
          options.exchange,
          options.request,
          options.now ?? new Date(), timeZone, options.context,
        );
    requestFailed ||= acquisition.requestFailed === true;
    raw = acquisition.points;
    window = resolveIntradaySessionWindow(raw, {
      rangePreset: options.request.rangePreset,
      session: options.request.session,
      timeZone,
    });
    sawNonIntradayData ||= window.points.length > 0 && !hasIntradayBars(window, timeZone);
  }

  if (window.points.length === 0) {
    const requestedWindow = options.request.session
      ? sessionUtcBounds(options.request.session, timeZone)
      : null;
    return {
      ...window,
      bufferedPoints: [],
      start: requestedWindow?.start ?? window.start,
      end: requestedWindow?.end ?? window.end,
      unavailableReason: unavailableReason(
        options.symbol,
        options.request,
        requestFailed ? "failed" : sawNonIntradayData ? "not-intraday" : "empty",
        retention,
        timeZone,
      ),
    };
  }
  if (!hasIntradayBars(window, timeZone)) {
    const requestedWindow = options.request.session
      ? sessionUtcBounds(options.request.session, timeZone)
      : null;
    return {
      points: [],
      bufferedPoints: [],
      sessionDates: window.sessionDates,
      start: requestedWindow?.start ?? null,
      end: requestedWindow?.end ?? null,
      unavailableReason: unavailableReason(options.symbol, options.request, requestFailed ? "failed" : "not-intraday"),
    };
  }
  const bufferedPoints = normalizedPoints(raw);
  // Earlier rows feed study warmup; later rows cannot affect this window.
  const nonpositive = bufferedPoints.filter((point) => point.close <= 0
    && getPricePointTimestamp(point) <= window.end!.getTime());
  if (nonpositive.length) {
    // Metadata is needed only at this boundary. Do not infer a futures domain
    // from a ticker suffix, a contract multiplier, or an option security type.
    const reportedQuote = await options.provider.getQuote(options.symbol, options.exchange, options.context).catch(logFailure("chart-composer.session-history", "Read intraday instrument metadata failed"));
    const quote = reportedQuote?.symbol.trim().toUpperCase() === options.symbol.trim().toUpperCase()
      ? reportedQuote : undefined;
    const instrumentType = quote?.instrumentType?.trim().toUpperCase() || null;
    if (instrumentType === "FUTURE" || instrumentType === "FUTURES" || instrumentType === "FUT") {
      return { ...window, bufferedPoints, unavailableReason: null, quote, session: acquisition.session, sourceKey: acquisition.sourceKey };
    }
    const priceDomainFailure: IntradayPriceDomainFailure = Object.freeze({
      reason: "nonpositive-price",
      instrumentType,
      sourcePoints: Object.freeze(nonpositive.map((point) => Object.freeze({
        ...point,
        date: new Date(point.date).toISOString(),
        ...(point.historySource ? { historySource: Object.freeze({ ...point.historySource }) } : {}),
      }))),
    });
    return {
      ...window, points: [], bufferedPoints: [], quote, priceDomainFailure,
      unavailableReason: `Intraday history for ${options.symbol} is unavailable: ${nonpositive.length} nonpositive close${nonpositive.length === 1 ? "" : "s"} in the selected window or its calculation buffer require verified futures metadata (type: ${instrumentType ?? "unknown"}).`,
    };
  }
  return { ...window, bufferedPoints, unavailableReason: null, session: acquisition.session, sourceKey: acquisition.sourceKey };
}
