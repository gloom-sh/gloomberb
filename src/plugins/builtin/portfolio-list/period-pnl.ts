import type { Quote } from "../../../types/financials";
import { loadCostFxRate, type CostFxHistoryClient } from "../../../portfolio/cost-fx";
import { withFuturesContractSize, isFuturesTicker, type PortfolioFuturesTerms } from "../../../portfolio/futures-positions";
import { periodPnl, type PeriodClose, type PeriodPnl, type PeriodPnlHolding } from "../../../portfolio/period-pnl";
import { getPortfolioPositionMetrics } from "../../../portfolio/position-metrics";
import { barSessionDay } from "../../../market-data/market/period-return";
import { cleanFloat32Price } from "../../../cli/history-rows";
import type { DataProvider } from "../../../types/data-provider";
import type { TickerRecord } from "../../../types/ticker";
import { mapWithConcurrency } from "../../../utils/concurrency";
import { errorMessage } from "../../../utils/errors";
import { logFailure } from "../../../utils/log-failure";
import type { PriceWindow } from "../../../utils/price-window";
import { loadReturnSeries } from "../ticker-detail/data-panes/returns-history";
import { buildReturnRows, isTodayReturnRow, returnBaseCloseDay } from "../ticker-detail/data-panes/returns-model";

/** Holdings whose daily closes are read at once. */
const HISTORY_READS = 6;

export interface LoadedPeriodPnl extends PeriodPnl {
  window: PriceWindow;
  /** Holdings whose closes could not be read, with why. */
  failures: { symbol: string; error: string }[];
  /** Holdings whose lots are dated inside the window: their P&L runs from the start close all the same. */
  boughtInWindow: string[];
}

/**
 * A holding's close before the window and its last close in it, from the
 * daily bars RETURN reads for the same dates (its base close and its last
 * row), so `portfolio show --from` and `fn RETURN --from` agree to the cent.
 */
async function windowCloses(provider: DataProvider, ticker: TickerRecord, window: PriceWindow, now: number, refresh: boolean) {
  const series = await loadReturnSeries(provider, {
    symbol: ticker.metadata.ticker, exchange: ticker.metadata.exchange ?? "", range: "1M", resolution: "1d", support: [], now, window, forceRefresh: refresh,
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
  return { start, end, partialEnd: isTodayReturnRow(last, series.resolution, venue, now) };
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
  const boughtInWindow = held.filter((ticker) => ticker.metadata.positions.some((position) => position.portfolio === portfolioId
    && position.shares !== 0 && !!position.dateAcquired && position.dateAcquired >= window.from)).map((ticker) => ticker.metadata.ticker);
  const holdings = await mapWithConcurrency(held, HISTORY_READS, async (ticker): Promise<PeriodPnlHolding> => {
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
    return { symbol, priceUnits: units, currency: quoteCurrency, ...closes };
  });
  // Each currency's FX close on each day a holding in it starts or ends on.
  const needed = new Map<string, { from: string; day: string }>();
  for (const holding of holdings) {
    if (holding.currency.toUpperCase() === currency.toUpperCase()) continue;
    for (const close of [holding.start, holding.end]) if (close) needed.set(`${holding.currency}|${close.day}`, { from: holding.currency, day: close.day });
  }
  const rates = new Map(await mapWithConcurrency([...needed], 4, async ([key, { from, day }]) =>
    [key, await loadCostFxRate(from, currency, day, fxHistory, new Date(now))
      .then((reading) => reading.rate)
      .catch(logFailure("portfolio.period-pnl", "Reading a window's FX close failed", null))] as const));
  const result = periodPnl(holdings.map((holding) => Number.isFinite(holding.priceUnits) ? holding : { ...holding, start: null }), currency,
    (from, day) => rates.get(`${from}|${day}`) ?? null);
  return { ...result, window, failures: failures.sort((a, b) => a.symbol.localeCompare(b.symbol)), boughtInWindow };
}
