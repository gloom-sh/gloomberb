import type { DataProvider } from "../../types/data-provider";
import type { PricePoint } from "../../types/financials";
import type { TimeRange } from "../../time-series/range";
import {
  getPresetResolution,
  isIntradayResolution,
  type ManualChartResolution,
} from "../../time-series/resolution";
import { resolveExchangeTimeZone } from "../../utils/exchanges";
import { getPricePointTimestamp } from "../../utils/price-history";
import { zonedWallClockToUtcMs } from "../../utils/zoned-date-time";

export type ShotIntradayRangePreset = "1D" | "1W";

export interface ShotIntradayRequest {
  rangePreset: ShotIntradayRangePreset;
  resolution: ManualChartResolution;
  session: string | null;
}

export interface ShotIntradayWindow {
  points: PricePoint[];
  sessionDates: string[];
  start: Date | null;
  end: Date | null;
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

export function parseShotSessionDate(value: string): {
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

export function shotSessionUtcBounds(value: string, timeZone: string): {
  start: Date;
  end: Date;
} {
  const parsed = parseShotSessionDate(value);
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
    if (!Number.isFinite(timestamp) || !Number.isFinite(point.close) || point.close <= 0) continue;
    byTimestamp.set(timestamp, {
      ...point,
      date: point.date instanceof Date ? point.date : new Date(timestamp),
    });
  }
  return [...byTimestamp.values()].sort(
    (left, right) => getPricePointTimestamp(left) - getPricePointTimestamp(right),
  );
}

export function resolveShotIntradaySessionWindow(
  points: readonly PricePoint[],
  options: {
    rangePreset: ShotIntradayRangePreset;
    session?: string | null;
    timeZone?: string | null;
  },
): ShotIntradayWindow {
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
  if (requestedSession) parseShotSessionDate(requestedSession);
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

export function hasIntradayBars(window: ShotIntradayWindow, timeZone = "UTC"): boolean {
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

export function resolveShotIntradayRequest(options: {
  rangePreset?: unknown;
  chartResolution?: unknown;
  session?: unknown;
}): ShotIntradayRequest {
  const session = typeof options.session === "string" && options.session.trim()
    ? options.session.trim()
    : null;
  if (session) parseShotSessionDate(session);
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

function unavailableReason(symbol: string, request: ShotIntradayRequest, kind: "empty" | "not-intraday"): string {
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
  request: ShotIntradayRequest,
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
  request: ShotIntradayRequest,
  now: Date,
): Promise<PricePoint[]> {
  if (!provider.getDetailedPriceHistory) return [];
  if (request.session) {
    const timeZone = resolveExchangeTimeZone(exchange) ?? "UTC";
    const bounds = shotSessionUtcBounds(request.session, timeZone);
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

export async function loadShotIntradayWindow(options: {
  provider: DataProvider;
  symbol: string;
  exchange: string;
  request: ShotIntradayRequest;
  now?: Date;
}): Promise<ShotIntradayWindow & { unavailableReason: string | null }> {
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
  let window = resolveShotIntradaySessionWindow(raw, {
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
    window = resolveShotIntradaySessionWindow(raw, {
      rangePreset: options.request.rangePreset,
      session: options.request.session,
      timeZone,
    });
    sawNonIntradayData ||= window.points.length > 0 && !hasIntradayBars(window, timeZone);
  }

  if (window.points.length === 0) {
    const requestedWindow = options.request.session
      ? shotSessionUtcBounds(options.request.session, timeZone)
      : null;
    return {
      ...window,
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
      ? shotSessionUtcBounds(options.request.session, timeZone)
      : null;
    return {
      points: [],
      sessionDates: window.sessionDates,
      start: requestedWindow?.start ?? null,
      end: requestedWindow?.end ?? null,
      unavailableReason: unavailableReason(options.symbol, options.request, "not-intraday"),
    };
  }
  return { ...window, unavailableReason: null };
}
