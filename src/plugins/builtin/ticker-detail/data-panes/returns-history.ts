import { fetchHistoryResult, InvalidHistoryResultError } from "../../../../sources/history-result";
import { historyRetentionNotice, isHistoryRetentionError } from "../../../../sources/history-retention";
import {
  getChartResolutionLabel,
  type ChartResolutionSupport,
  type ManualChartResolution,
} from "../../../../time-series/resolution";
import type { DataProvider } from "../../../../types/data-provider";
import type { PricePoint } from "../../../../types/financials";
import { isRoundTheClockCoin } from "../../../../utils/crypto-pair";
import { isCurrencyPairListing } from "../../../../utils/fx-market-hours";
import {
  effectiveReturnResolution,
  endsAtLatestBar,
  latestBarTime,
  returnLookbackMs,
  returnSupportRange,
  returnVisibleFrom,
  returnWindowEnd,
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
  } catch {
    return "";
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
  const { symbol, exchange, range, support, now } = request;
  const interval = effectiveReturnResolution(range, request.resolution, support);
  const venue = await sessionVenue(provider, symbol, exchange);
  const windowEnd = returnWindowEnd({ symbol, exchange: venue }, now);
  const visibleFrom = returnVisibleFrom(range, interval, windowEnd.end);
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
    visibleFrom: endsAtLatestBar(range) && latest !== null && latest < windowEnd.end
      ? returnVisibleFrom(range, interval, latest)
      : visibleFrom,
    visibleTo: now,
    ...(result.coverageStart ? { coverageStart: result.coverageStart } : {}),
    range,
    resolution: interval,
    ...(windowEnd.lastSession ? { lastSession: windowEnd.lastSession } : {}),
    venue,
  };
}
