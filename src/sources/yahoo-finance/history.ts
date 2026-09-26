import type { TimeRange } from "../../time-series/range";
import {
  DEFAULT_CHART_RESOLUTION_SUPPORT,
  CHART_RESOLUTION_STEP_MS,
  isIntradayResolution,
  type ChartResolutionSupport,
  type ManualChartResolution,
} from "../../time-series/resolution";
import { repairIsolatedIntradayOhlcOutliers } from "../../time-series/history-quality";
import type { PricePoint } from "../../types/financials";
import type { HistorySession, PriceHistoryResult } from "../../types/price-history";
import { parseHistorySession } from "../../market-data/history-session";
import { getPublishedUsEquitySession } from "../../market-data/published-us-sessions";
import { CANONICAL_EXCHANGE_ALIASES, canonicalExchange, parsePublicTickerKey } from "../../utils/exchanges";
import { canonicalHistoryInterval } from "../history-retention";
import { resolveCurrencyUnit } from "../../utils/currency-units";
import { getYahooSymbol, getYahooSymbolsToTry } from "./symbols";
import type { ChartResult } from "./types";
import { matchesYahooChartInterval } from "./yahoo-chart-interval";

const RANGE_PARAMS: Record<TimeRange, { range: string; interval: ManualChartResolution }> = {
  "1D": { range: "1d", interval: "5m" },
  "1W": { range: "5d", interval: "5m" },
  "1M": { range: "1mo", interval: "15m" },
  "3M": { range: "3mo", interval: "1h" },
  "6M": { range: "6mo", interval: "1d" },
  "1Y": { range: "1y", interval: "1d" },
  "5Y": { range: "5y", interval: "1d" },
  "ALL": { range: "max", interval: "1wk" },
};

const YAHOO_RESOLUTION_SUPPORT = DEFAULT_CHART_RESOLUTION_SUPPORT;

type YahooChartFetcher = (
  symbol: string,
  range: string,
  interval: ManualChartResolution,
) => Promise<{
  meta: NonNullable<ChartResult["meta"]>;
  history: PricePoint[];
  events?: ChartResult["events"];
  observedAt?: number;
  regularHoursOnly?: boolean;
}>;

const sessionDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});

function sessionDate(time: number): string {
  const parts = new Map(sessionDateFormatter.formatToParts(time).map(part => [part.type, part.value]));
  return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
}

function yahooHistorySession(
  ticker: string, exchange: string, symbol: string, resolution: ManualChartResolution,
  result: Awaited<ReturnType<YahooChartFetcher>>,
): HistorySession | undefined {
  const { meta, history, observedAt, regularHoursOnly } = result;
  const target = parsePublicTickerKey(ticker);
  const venue = canonicalExchange(target.exchange || exchange);
  if (!isIntradayResolution(resolution) || regularHoursOnly !== true || !history.length
    || symbol !== getYahooSymbol(ticker, exchange) || meta.symbol !== symbol
    || !["EQUITY", "ETF"].includes(meta.instrumentType ?? "") || meta.currency !== "USD"
    || !venue || canonicalExchange(meta.exchangeName) !== venue
    || meta.exchangeTimezoneName !== "America/New_York"
    || !matchesYahooChartInterval(resolution, meta.dataGranularity)
    || typeof observedAt !== "number" || !Number.isFinite(observedAt) || observedAt <= 0 || observedAt > Date.now()) return undefined;
  // Unknown full names are descriptive. A second recognized venue must agree.
  const fullVenue = canonicalExchange(meta.fullExchangeName);
  if (meta.fullExchangeName && CANONICAL_EXCHANGE_ALIASES[meta.fullExchangeName.trim().toUpperCase()]
    && fullVenue !== venue) return undefined;
  if (!getPublishedUsEquitySession(venue, sessionDate(observedAt))) return undefined;
  const step = CHART_RESOLUTION_STEP_MS[resolution];
  let hasFinalObservation = false;
  let previousTime = 0;
  for (const [index, point] of history.entries()) {
    const time = point.date.getTime();
    if (!Number.isFinite(time) || time > observedAt || time <= previousTime) return undefined;
    previousTime = time;
    const session = getPublishedUsEquitySession(venue, sessionDate(time));
    if (!session || session.kind !== "session" || time < session.open || time > session.close) return undefined;
    if (time === session.close || (time - session.open) % step !== 0) {
      // The chart can append the current/final regular-market observation.
      // Its float32 close and minute label must match the source quote facts;
      // such an observation is distinct from an opening-time candle.
      const quoteTime = Number(meta.regularMarketTime) * 1000;
      if (index !== history.length - 1 || !Number.isFinite(quoteTime) || quoteTime > observedAt
        || Math.floor(quoteTime / 60_000) !== Math.floor(time / 60_000)
        || typeof meta.regularMarketPrice !== "number" || !Number.isFinite(meta.regularMarketPrice)
        || Math.fround(point.close) !== Math.fround(meta.regularMarketPrice)) return undefined;
      hasFinalObservation = true;
    }
  }
  return parseHistorySession({ version: 1, kind: "regular", calendar: "us-equity", timeZone: "America/New_York",
    symbol: target.symbol, exchange: venue, interval: canonicalHistoryInterval(resolution), source: "yahoo",
    timestampConvention: hasFinalObservation ? "bar-open-with-final-observation" : "bar-open", barAlignment: "session-open", observedAt },
    { symbol: target.symbol, exchange: venue, interval: resolution }) ?? undefined;
}

export function getYahooChartResolutionSupport(): ChartResolutionSupport[] {
  return YAHOO_RESOLUTION_SUPPORT;
}

export function getYahooChartResolutionCapabilities(): ManualChartResolution[] {
  return YAHOO_RESOLUTION_SUPPORT.map((entry) => entry.resolution);
}

export async function loadYahooPriceHistoryWithMetadata({ ticker, exchange, range, fetchChart }: {
  ticker: string; exchange: string; range: TimeRange; fetchChart: YahooChartFetcher;
}): Promise<PriceHistoryResult> {
  const params = RANGE_PARAMS[range];
  return loadYahooPriceHistoryForResolutionWithMetadata({
    ticker,
    exchange,
    chartRange: params.range,
    resolution: params.interval,
    fetchChart,
  });
}

export async function loadYahooPriceHistoryForResolutionWithMetadata({
  ticker,
  exchange,
  bufferRange,
  chartRange,
  resolution,
  fetchChart,
}: {
  ticker: string;
  exchange: string;
  bufferRange?: TimeRange;
  chartRange?: string;
  resolution: ManualChartResolution;
  fetchChart: YahooChartFetcher;
}): Promise<PriceHistoryResult> {
  const effectiveChartRange = chartRange ?? RANGE_PARAMS[bufferRange ?? "1Y"].range;
  const symbolsToTry = getYahooSymbolsToTry(ticker, exchange);
  let lastError: any;

  for (const symbol of symbolsToTry) {
    try {
      const result = await fetchChart(symbol, effectiveChartRange, resolution);
      const { meta, history } = result;
      const session = yahooHistorySession(ticker, exchange, symbol, resolution, result);

      const { divisor } = resolveCurrencyUnit(meta.currency || "USD");
      if (divisor !== 1) {
        for (const point of history) {
          point.close /= divisor;
          if (point.open != null) point.open /= divisor;
          if (point.high != null) point.high /= divisor;
          if (point.low != null) point.low /= divisor;
        }
      }

      const points = isIntradayResolution(resolution)
        ? repairIsolatedIntradayOhlcOutliers(history)
        : history;
      return { points, resolution, ...(session ? { session } : {}) };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error(`No history for ${ticker}`);
}
