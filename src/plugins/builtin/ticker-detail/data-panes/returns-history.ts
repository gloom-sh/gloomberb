import { logFailure } from "../../../../utils/log-failure";
import { fetchHistoryResult, InvalidHistoryResultError } from "../../../../sources/history-result";
import { historyRetentionNotice, isHistoryRetentionError } from "../../../../sources/history-retention";
import {
  CHART_RESOLUTION_STEP_MS,
  DEFAULT_CHART_RESOLUTION_SUPPORT,
  getChartResolutionLabel,
  getSupportedChartResolutionsForViewport,
  isIntradayResolution,
  type ChartResolutionSupport,
  type ManualChartResolution,
} from "../../../../time-series/resolution";
import { priceWindowBarStart, type PriceWindow } from "../../../../utils/price-window";
import type { DataProvider } from "../../../../types/data-provider";
import type { PricePoint } from "../../../../types/financials";
import { isRoundTheClockCoin } from "../../../../utils/crypto-pair";
import { isCurrencyPairListing } from "../../../../utils/fx-market-hours";
import {
  effectiveReturnResolution,
  endsAtLatestBar,
  latestBarTime,
  returnLookbackMs,
  returnRowsFrom,
  returnSupportRange,
  returnVisibleFrom,
  returnWindowEnd,
  returnWindowLookbackMs,
  type ReturnRange,
} from "./returns-model";

export interface ReturnSeries {
  points: PricePoint[];
  visibleFrom: number;
  visibleTo: number;
  coverageStart?: string;
  range: ReturnRange;
  resolution: ManualChartResolution;
  /** The market is shut: the local date of its last session, which the window ends at. */
  lastSession?: string;
  /** The venue whose sessions the window follows; empty when none is known. */
  venue: string;
}

export interface ReturnSeriesRequest {
  symbol: string;
  exchange: string;
  range: ReturnRange;
  /** The chosen interval; a range it cannot cover loads the nearest coarser one. */
  resolution: ManualChartResolution;
  /** What the source serves; empty uses the default intervals. */
  support: readonly ChartResolutionSupport[];
  now: number;
  forceRefresh?: boolean;
  /** Dates in place of the range (`--from 2007 --to 2009`): every bar dated inside them. */
  window?: PriceWindow | null;
}

function historyErrorMessage(error: unknown, resolution: ManualChartResolution): Error {
  const label = getChartResolutionLabel(resolution);
  if (isHistoryRetentionError(error)) return new Error(historyRetentionNotice(error.retention, label, null));
  // The source answered at another cadence than asked: those bars are not this interval's returns.
  if (error instanceof InvalidHistoryResultError) return new Error(`${label} bars are unavailable for this ticker`);
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * The venue whose sessions set where the window ends: the one the ticker
 * names, else the listing its quote names, so a bare VTI ends at the NYSE
 * Arca close on a weekend. Coins and currency pairs need none.
 */
async function sessionVenue(provider: DataProvider, symbol: string, exchange: string): Promise<string> {
  if (exchange || isRoundTheClockCoin(symbol) || isCurrencyPairListing(symbol, exchange)) return exchange;
  try {
    const metadata = provider.getQuoteMetadata
      ? await provider.getQuoteMetadata(symbol, exchange)
      : await provider.getQuote(symbol, exchange);
    return metadata?.listingExchangeName ?? "";
  } catch (error) {
    return logFailure("ticker-detail.data-panes.returns-history", "Read return session venue failed", "")(error);
  }
}

/**
 * The bars of a return window and where it starts and ends, as RETURN, its
 * report and its capture all load them: the window ends now while the
 * market trades and at its last session's close while it is shut
 * (`returnWindowEnd`); the request reaches back far enough for the bar
 * before the window, which every return is measured from.
 */
export async function loadReturnSeries(provider: DataProvider, request: ReturnSeriesRequest): Promise<ReturnSeries> {
  if (request.window) return loadReturnWindow(provider, request, request.window);
  const { symbol, exchange, range, support, now } = request;
  const interval = effectiveReturnResolution(range, request.resolution, support);
  const venue = await sessionVenue(provider, symbol, exchange);
  const windowEnd = returnWindowEnd({ symbol, exchange: venue }, now);
  const visibleFrom = returnVisibleFrom(range, interval, windowEnd.end, venue || undefined);
  const start = new Date(visibleFrom - returnLookbackMs(range, interval, support));
  const end = new Date(now);
  const context = request.forceRefresh ? { cacheMode: "refresh" as const } : undefined;
  let result;
  try {
    // Exact bounds first, then the interval's range history, as charts do
    // when a source keeps no bars for the exact window.
    result = await fetchHistoryResult(provider, symbol, exchange, { kind: "detail", start, end, interval }, context);
    if (!result?.points.length) {
      result = await fetchHistoryResult(provider, symbol, exchange, { kind: "resolution", range: returnSupportRange(range), resolution: interval }, context) ?? result;
    }
  } catch (error) {
    throw historyErrorMessage(error, interval);
  }
  if (!result) throw new Error("Price history unavailable");
  const latest = latestBarTime(result.points);
  return {
    points: result.points,
    // A 1W to 5Y window's rows start after its base close, found among the bars by their session days.
    visibleFrom: endsAtLatestBar(range) && latest !== null && latest < windowEnd.end
      ? returnVisibleFrom(range, interval, latest, venue || undefined)
      : returnRowsFrom(result.points, range, interval, windowEnd.end, venue || undefined),
    visibleTo: now,
    ...(result.coverageStart ? { coverageStart: result.coverageStart } : {}),
    range,
    resolution: interval,
    ...(windowEnd.lastSession ? { lastSession: windowEnd.lastSession } : {}),
    venue,
  };
}

/**
 * The bars of a dated window and the one before it, in the chosen interval
 * when the window is short enough for it and else the nearest coarser one, as
 * a chart of those dates picks. A source that keeps no intraday bars that far
 * back (it serves none, or says how far back it keeps them) answers in daily
 * bars. A weekly or monthly window starts with the week or month its first
 * date falls in, as `history` does.
 */
async function loadReturnWindow(provider: DataProvider, request: ReturnSeriesRequest, window: PriceWindow): Promise<ReturnSeries> {
  const { symbol, exchange, support, now } = request;
  const first = Date.parse(`${window.from}T00:00:00Z`);
  const last = Date.parse(`${window.to}T23:59:59.999Z`);
  const available = getSupportedChartResolutionsForViewport("ALL", support.length > 0 ? support : DEFAULT_CHART_RESOLUTION_SUPPORT,
    { start: new Date(first), end: new Date(last) });
  const step = CHART_RESOLUTION_STEP_MS[request.resolution];
  let interval = available.includes(request.resolution) ? request.resolution
    : available.find((candidate) => CHART_RESOLUTION_STEP_MS[candidate] >= step) ?? available.at(-1) ?? "1d";
  const venue = await sessionVenue(provider, symbol, exchange);
  const context = request.forceRefresh ? { cacheMode: "refresh" as const } : undefined;
  const load = async (resolution: ManualChartResolution) => {
    // A daily or longer bar is stamped at midnight UTC, so the window takes every bar from its first date's day, week or month on.
    const visibleFrom = isIntradayResolution(resolution) ? first : priceWindowBarStart(window.from, resolution) - 1;
    const result = await fetchHistoryResult(provider, symbol, exchange,
      { kind: "detail", start: new Date(visibleFrom - returnWindowLookbackMs(resolution)), end: new Date(Math.min(last, now)), interval: resolution }, context);
    return { result, visibleFrom };
  };
  let loaded: Awaited<ReturnType<typeof load>> | null = null;
  try {
    loaded = await load(interval);
  } catch (error) {
    // `1H history starts Oct 23, 2024`: a window before that is read in daily bars, which the report says it got.
    if (!isIntradayResolution(interval) || !isHistoryRetentionError(error)) throw historyErrorMessage(error, interval);
  }
  if (!loaded?.result?.points.length && isIntradayResolution(interval)) {
    interval = "1d";
    try {
      loaded = await load(interval);
    } catch (error) {
      throw historyErrorMessage(error, interval);
    }
  }
  if (!loaded?.result) throw new Error("Price history unavailable");
  return {
    points: loaded.result.points,
    visibleFrom: loaded.visibleFrom,
    visibleTo: Math.min(last, now),
    ...(loaded.result.coverageStart ? { coverageStart: loaded.result.coverageStart } : {}),
    range: request.range,
    resolution: interval,
    venue,
  };
}
