import type { DataProvider } from "../types/data-provider";
import type { PricePoint, Quote } from "../types/financials";
import type { TimeRange } from "./range";
import {
  getPresetResolution,
  isIntradayResolution,
  type ManualChartResolution,
} from "./resolution";
import { resolveExchangeTimeZone } from "../utils/exchanges";
import { getPricePointTimestamp } from "../utils/price-history";
import { pricePointIntegrity } from "../utils/price-history-integrity";
import { zonedWallClockToUtcMs } from "../utils/zoned-date-time";

export type IntradayRangePreset = "1D" | "1W";

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

export interface IntradayPriceDomainFailure {
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
}

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const HISTORICAL_RETRY_DELAY_MS = 61 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

function sessionDateFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function sessionDate(timestamp: number, timeZone: string): string {
  const parts = new Map(
    sessionDateFormatter(timeZone)
      .formatToParts(new Date(timestamp))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
}

export function parseSessionDate(value: string): {
  year: number;
  month: number;
  day: number;
} {
  const match = DATE_ONLY_PATTERN.exec(value.trim());
  if (!match) throw new Error(`Invalid --session value "${value}". Use YYYY-MM-DD.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year
    || candidate.getUTCMonth() !== month - 1
    || candidate.getUTCDate() !== day
  ) {
    throw new Error(`Invalid --session value "${value}". Use a real calendar date.`);
  }
  return { year, month, day };
}

export function sessionUtcBounds(value: string, timeZone: string): {
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
  return [...new Set(normalizedPoints(points).map((point) => sessionDate(getPricePointTimestamp(point), timeZone)))];
}

export function resolveIntradaySessionWindow(
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
    const date = sessionDate(getPricePointTimestamp(point), timeZone);
    const sessionPoints = bySession.get(date) ?? [];
    sessionPoints.push(point);
    bySession.set(date, sessionPoints);
  }

  const requestedSession = options.session?.trim() || null;
  if (requestedSession) parseSessionDate(requestedSession);
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

export function hasIntradayBars(window: IntradayWindow, timeZone = "UTC"): boolean {
  if (window.points.length < 2) return false;
  const pointsBySession = new Map<string, number[]>();
  for (const point of window.points) {
    const timestamp = getPricePointTimestamp(point);
    const date = sessionDate(timestamp, timeZone);
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
}): IntradayRequest {
  const session = typeof options.session === "string" && options.session.trim()
    ? options.session.trim()
    : null;
  if (session) parseSessionDate(session);
  const rangePreset = session
    ? "1D"
    : options.rangePreset === "1W" ? "1W" : "1D";
  const requestedResolution = typeof options.chartResolution === "string"
    ? options.chartResolution
    : "auto";
  const resolution = requestedResolution === "auto"
    ? getPresetResolution(rangePreset)
    : requestedResolution as ManualChartResolution;
  if (!isIntradayResolution(resolution)) {
    throw new Error(`GIP requires an intraday chart resolution, got "${requestedResolution}".`);
  }
  return { rangePreset, resolution, session };
}

function unavailableReason(symbol: string, request: IntradayRequest, kind: "empty" | "not-intraday"): string {
  const window = request.session
    ? `session ${request.session}`
    : request.rangePreset === "1W" ? "the latest five sessions" : "the latest session";
  return kind === "not-intraday"
    ? `The market-data provider did not return intraday bars for ${symbol} for ${window}.`
    : `No intraday price history is available for ${symbol} for ${window}.`;
}

async function loadTrailingHistory(
  provider: DataProvider,
  symbol: string,
  exchange: string,
  request: IntradayRequest,
): Promise<PricePoint[]> {
  if (!provider.getPriceHistoryForResolution) return [];
  const fetchRange: TimeRange = request.rangePreset === "1W" && request.resolution !== "1m"
    ? "1M"
    : "1W";
  try {
    return await provider.getPriceHistoryForResolution(
      symbol,
      exchange,
      fetchRange,
      request.resolution,
    );
  } catch {
    return [];
  }
}

async function loadHistoricalFallback(
  provider: DataProvider,
  symbol: string,
  exchange: string,
  request: IntradayRequest,
  now: Date,
): Promise<PricePoint[]> {
  if (!provider.getDetailedPriceHistory) return [];
  if (request.session) {
    const timeZone = resolveExchangeTimeZone(exchange) ?? "UTC";
    const bounds = sessionUtcBounds(request.session, timeZone);
    return provider.getDetailedPriceHistory(
      symbol,
      exchange,
      bounds.start,
      bounds.end,
      request.resolution,
    ).catch(() => []);
  }
  const end = new Date(now.getTime() - HISTORICAL_RETRY_DELAY_MS);
  const lookbackDays = request.rangePreset === "1W" ? 35 : 8;
  const start = new Date(end.getTime() - lookbackDays * DAY_MS);
  return provider.getDetailedPriceHistory(
    symbol,
    exchange,
    start,
    end,
    request.resolution,
  ).catch(() => []);
}

export async function loadIntradayWindow(options: {
  provider: DataProvider;
  symbol: string;
  exchange: string;
  request: IntradayRequest;
  now?: Date;
}): Promise<LoadedIntradayWindow> {
  const timeZone = resolveExchangeTimeZone(options.exchange) ?? "UTC";
  let raw = options.request.session
    ? await loadHistoricalFallback(
        options.provider,
        options.symbol,
        options.exchange,
        options.request,
        options.now ?? new Date(),
      )
    : await loadTrailingHistory(
        options.provider,
        options.symbol,
        options.exchange,
        options.request,
      );
  let window = resolveIntradaySessionWindow(raw, {
    rangePreset: options.request.rangePreset,
    session: options.request.session,
    timeZone,
  });
  let sawNonIntradayData = window.points.length > 0 && !hasIntradayBars(window, timeZone);

  if (!hasIntradayBars(window, timeZone)) {
    raw = options.request.session
      ? await loadTrailingHistory(
          options.provider,
          options.symbol,
          options.exchange,
          options.request,
        )
      : await loadHistoricalFallback(
          options.provider,
          options.symbol,
          options.exchange,
          options.request,
          options.now ?? new Date(),
        );
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
        sawNonIntradayData ? "not-intraday" : "empty",
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
      unavailableReason: unavailableReason(options.symbol, options.request, "not-intraday"),
    };
  }
  const bufferedPoints = normalizedPoints(raw);
  // Earlier rows feed study warmup; later rows cannot affect this window.
  const nonpositive = bufferedPoints.filter((point) => point.close <= 0
    && getPricePointTimestamp(point) <= window.end!.getTime());
  if (nonpositive.length) {
    // Metadata is needed only at this boundary. Do not infer a futures domain
    // from a ticker suffix, a contract multiplier, or an option security type.
    const reportedQuote = await options.provider.getQuote(options.symbol, options.exchange).catch(() => undefined);
    const quote = reportedQuote?.symbol.trim().toUpperCase() === options.symbol.trim().toUpperCase()
      ? reportedQuote : undefined;
    const instrumentType = quote?.instrumentType?.trim().toUpperCase() || null;
    if (instrumentType === "FUTURE" || instrumentType === "FUTURES" || instrumentType === "FUT") {
      return { ...window, bufferedPoints, unavailableReason: null, quote };
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
  return { ...window, bufferedPoints, unavailableReason: null };
}
