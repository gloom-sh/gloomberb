import type { Quote } from "../../../types/financials";
import { loadCostFxRate, type CostFxHistoryClient } from "../../../portfolio/cost-fx";
import { withFuturesContractSize, isFuturesTicker, type PortfolioFuturesTerms } from "../../../portfolio/futures-positions";
import { periodCurrency, periodPnl, type PeriodClose, type PeriodPnl, type PeriodPnlHolding, type PeriodPnlRow } from "../../../portfolio/period-pnl";
import { getPortfolioPositionMetrics } from "../../../portfolio/position-metrics";
import { barSessionDay, periodDayText } from "../../../market-data/market/period-return";
import { quoteHeadlineTime } from "../../../market-data/market/status";
import { formatUtcDayTime } from "../../../utils/utc-time";
import { cleanFloat32Price } from "../../../cli/history-rows";
import type { DataProvider } from "../../../types/data-provider";
import type { TickerRecord } from "../../../types/ticker";
import { mapWithConcurrency } from "../../../utils/concurrency";
import { errorMessage } from "../../../utils/errors";
import { logFailure } from "../../../utils/log-failure";
import type { PriceWindow } from "../../../utils/price-window";
import type { ChartResolutionSupport } from "../../../time-series/resolution";
import { loadReturnSeries } from "../ticker-detail/data-panes/returns-history";
import { buildReturnRows, isTodayReturnRow, returnBaseCloseDay } from "../ticker-detail/data-panes/returns-model";

/** Holdings whose daily closes are read at once: `portfolio show --from`, `fn PF --from` and `shot PF` alike. */
const PERIOD_HISTORY_READS = 6;

/**
 * Daily bars over any window: a day or two would otherwise be read in hourly
 * bars (a future from a Globex hour, not its settlement) and more than five
 * years in weekly ones (a window from a Wednesday starting the Friday before).
 */
const DAILY_CLOSES: readonly ChartResolutionSupport[] = [{ resolution: "1d", maxRange: "ALL" }];

export interface LoadedPeriodPnl extends PeriodPnl {
  window: PriceWindow;
  /** Holdings whose closes could not be read, with why. */
  failures: { symbol: string; error: string }[];
  /** Why each holding in `unpriced` has no P&L: the source's answer, no close at one end, no FX close, no contract size. */
  unpricedReasons: { symbol: string; reason: string }[];
  /** Holdings whose lots are dated inside the window: their P&L runs from the start close all the same. */
  boughtInWindow: string[];
  /** When the window ends today with a session still trading: the latest price's time, in ms. */
  latestPriceAt: number | null;
}

/**
 * A holding's close before the window and its last close in it, read as
 * RETURN reads a window (its base close and its last row) but always in daily
 * bars, so the P&L runs close to close, a future's from settlement to
 * settlement, however short or long the window. Over the windows RETURN reads
 * in daily bars too, the two agree to the cent.
 */
async function windowCloses(provider: DataProvider, ticker: TickerRecord, window: PriceWindow, now: number, refresh: boolean) {
  const series = await loadReturnSeries(provider, {
    symbol: ticker.metadata.ticker, exchange: ticker.metadata.exchange ?? "", range: "1M", resolution: "1d", support: DAILY_CLOSES, now, window, forceRefresh: refresh,
  });
  const rows = buildReturnRows(series.points, series.visibleFrom, series.visibleTo).filter((row) => row.price !== null);
  // Newest first, as RETURN lists them.
  const last = rows[0];
  const venue = series.venue || undefined;
  const baseDay = rows.length ? returnBaseCloseDay(series.points, series.visibleFrom, series.resolution, venue, now) : null;
  if (!last || last.price === null || last.cumulativeChange === null || !baseDay) return { start: null, end: null, partialEnd: false };
  // Bars stored as float32 read back as 63.150001525878906; the closes are the prices `history` prints.
  const start: PeriodClose = { day: baseDay, price: cleanFloat32Price(last.price - last.cumulativeChange) };
  const end: PeriodClose = { day: barSessionDay(last.timestamp, venue), price: cleanFloat32Price(last.price) };
  // Today's session still trading, by the venue's calendar or by the source, which marks a forming bar (a future's
  // day before its settlement) partial and a closed one it has not settled yet unsettled: its close is a last trade.
  const lastPoint = series.points.find((point) => new Date(point.date).getTime() === last.timestamp);
  const partialEnd = isTodayReturnRow(last, series.resolution, venue, now) || !!lastPoint?.partial || !!lastPoint?.unsettled;
  return { start, end, partialEnd };
}

/**
 * A portfolio's P&L by position between the close before `window.from` and
 * the last close on or before `window.to`, in `currency`, on the holdings it
 * holds now. A future counts its contracts at the size its terms give.
 */
export async function loadPeriodPnl({
  tickers, portfolioId, currency, window, provider, fxHistory, quotes, futures, now = Date.now(), refresh = false,
}: {
  tickers: readonly TickerRecord[];
  portfolioId: string;
  currency: string;
  window: PriceWindow;
  provider: DataProvider;
  fxHistory: CostFxHistoryClient;
  quotes?: ReadonlyMap<string, Quote | undefined>;
  futures?: ReadonlyMap<string, PortfolioFuturesTerms>;
  now?: number;
  refresh?: boolean;
}): Promise<LoadedPeriodPnl> {
  const held = tickers.filter((ticker) => ticker.metadata.positions.some((position) => position.portfolio === portfolioId && position.shares !== 0));
  const failures: LoadedPeriodPnl["failures"] = [];
  const sizeUnknown = new Set<string>();
  const latestTimes: number[] = [];
  const boughtInWindow = held.filter((ticker) => ticker.metadata.positions.some((position) => position.portfolio === portfolioId
    && position.shares !== 0 && !!position.dateAcquired && position.dateAcquired >= window.from)).map((ticker) => ticker.metadata.ticker);
  const holdings = await mapWithConcurrency(held, PERIOD_HISTORY_READS, async (ticker): Promise<PeriodPnlHolding> => {
    const symbol = ticker.metadata.ticker;
    const quote = quotes?.get(symbol) ?? null;
    const sized = isFuturesTicker(ticker) ? withFuturesContractSize(ticker, futures?.get(symbol)?.size) : ticker;
    const quoteCurrency = quote?.currency || ticker.metadata.currency || currency;
    const metrics = getPortfolioPositionMetrics(sized, portfolioId, quoteCurrency, undefined, quote);
    const closes = await windowCloses(provider, ticker, window, now, refresh).catch((error: unknown) => {
      failures.push({ symbol, error: errorMessage(error) });
      return { start: null, end: null, partialEnd: false };
    });
    // A future without a contract size has no value a contract: it stays unpriced rather than counted at one unit.
    const units = metrics.unknownContractSize ? Number.NaN : metrics.totalPriceUnits;
    if (metrics.unknownContractSize) sizeUnknown.add(symbol);
    if (closes.partialEnd && quote) latestTimes.push(quoteHeadlineTime(quote));
    return { symbol, priceUnits: units, currency: quoteCurrency, ...closes };
  });
  // Each major currency's FX close on each day a holding in it starts or ends on: GBP's for a price in pence.
  const needed = new Map<string, { from: string; day: string }>();
  for (const holding of holdings) {
    const { currency: major, own } = periodCurrency(holding.currency, currency);
    if (own) continue;
    for (const close of [holding.start, holding.end]) if (close) needed.set(`${major}|${close.day}`, { from: major, day: close.day });
  }
  const rates = new Map(await mapWithConcurrency([...needed], 4, async ([key, { from, day }]) =>
    [key, await loadCostFxRate(from, currency, day, fxHistory, new Date(now))
      .then((reading) => reading.rate)
      .catch(logFailure("portfolio.period-pnl", "Reading a window's FX close failed", null))] as const));
  const rate = (from: string, day: string) => rates.get(`${from}|${day}`) ?? null;
  const result = periodPnl(holdings.map((holding) => Number.isFinite(holding.priceUnits) ? holding : { ...holding, start: null }), currency, rate);
  const failed = new Map(failures.map((failure) => [failure.symbol, failure.error]));
  const unpricedReasons = holdings.filter((holding) => result.unpriced.includes(holding.symbol)).map((holding) => {
    const { currency: major, own } = periodCurrency(holding.currency, currency);
    const missingRate = !own ? [holding.start, holding.end].find((close) => close && rate(major, close.day) == null) : undefined;
    const reason = failed.has(holding.symbol) ? failed.get(holding.symbol)!.replace(/\.+$/, "")
      : sizeUnknown.has(holding.symbol) ? "contract size unknown"
      : !holding.start ? `no close before ${window.from}`
      : !holding.end ? `no close from ${window.from} to ${window.to}`
      : missingRate ? `no ${major} FX close on ${missingRate.day}`
      : "no close at one end of the window";
    return { symbol: holding.symbol, reason };
  }).sort((a, b) => a.symbol.localeCompare(b.symbol));
  return {
    ...result, window, failures: failures.sort((a, b) => a.symbol.localeCompare(b.symbol)), unpricedReasons, boughtInWindow,
    latestPriceAt: latestTimes.length ? Math.max(...latestTimes) : null,
  };
}

/** The one day every priced row shares at an end of the window, or null when they differ (a holiday on one venue). */
export function periodSharedDay(rows: readonly PeriodPnlRow[], end: "start" | "end"): string | null {
  const days = new Set(rows.flatMap((row) => row[end] ? [row[end]!.day] : []));
  return days.size === 1 ? [...days][0]! : null;
}

/**
 * What a period's P&L runs between, as every report of it says first:
 * `P&L from the close of Fri 23 Oct to the close of Fri 30 Oct`, or `to the
 * latest price (Thu 5 Nov 15:42 UTC)` when the window ends in a session still
 * trading.
 */
export function periodBasisText(result: LoadedPeriodPnl, { futuresHeld, now = Date.now() }: { futuresHeld: boolean; now?: number }): string {
  const year = new Date(now).getUTCFullYear();
  const startDay = periodSharedDay(result.rows, "start");
  const endDay = periodSharedDay(result.rows, "end");
  const partial = result.rows.some((row) => row.partialEnd);
  const start = startDay ? `the close of ${periodDayText(startDay, year)}` : "each holding's last close before the start";
  const end = partial
    ? `the latest price${result.latestPriceAt != null ? ` (${formatUtcDayTime({ time: result.latestPriceAt, dateOnly: false }, now)} UTC)` : ""}`
    : endDay ? `the close of ${periodDayText(endDay, year)}` : "each holding's last close in the window";
  // A future runs from its settlement; to a settlement too unless the window ends on its latest price.
  const futures = !futuresHeld ? "" : partial ? ", futures from their settlements" : ", futures at their settlements";
  return `P&L from ${start} to ${end}${futures}, on the holdings held now`;
}

/** `No P&L for GC=F (contract size unknown), 2382 (no close before 2020-03-18). The total leaves them out.` Null when every holding has one. */
export function periodUnpricedText(result: LoadedPeriodPnl, label: (symbol: string) => string = (symbol) => symbol): string | null {
  if (!result.unpricedReasons.length) return null;
  const named = result.unpricedReasons.map(({ symbol, reason }) => `${label(symbol)} (${reason})`).join(", ");
  return `No P&L for ${named}. The total leaves ${result.unpricedReasons.length === 1 ? "it" : "them"} out.`;
}

/** The holdings bought inside the window, whose P&L still runs from the start close: named, never left to look like a full period. */
export function periodBoughtText(result: LoadedPeriodPnl, label: (symbol: string) => string = (symbol) => symbol): string | null {
  const count = result.boughtInWindow.length;
  if (!count) return null;
  return `Bought inside the window: ${result.boughtInWindow.map(label).join(", ")}. ${count === 1 ? "Its" : "Their"} P&L runs from the start close, as if held all along.`;
}
