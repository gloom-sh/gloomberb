import type { ExposureHolding } from "../../../api-client/exposure";
import type { DataProvider } from "../../../types/data-provider";
import type { Portfolio, TickerRecord } from "../../../types/ticker";
import { publicTickerKey } from "../../../utils/exchanges";
import { resolveCurrencyUnit } from "../../../utils/currency-units";
import { convertCurrency } from "../../../utils/format";
import { getPortfolioPositionMetrics, getPortfolioQuoteDisplay, resolvePortfolioMarketValue } from "../portfolio-list/position-metrics";

/** Explicit NAV preserves cash, shorts and leverage; net holdings are never used as NAV. */
export async function portfolioHoldings(portfolio: Portfolio, tickers: TickerRecord[], nav: number, market: Pick<DataProvider, "getQuote" | "getExchangeRate">): Promise<ExposureHolding[]> {
  if (!Number.isFinite(nav) || nav <= 0) throw new Error(`Enter positive NAV in ${portfolio.currency} for ${portfolio.name}.`);
  const positions = tickers.filter(t => t.metadata.positions.some(p => p.portfolio === portfolio.id && p.shares !== 0));
  if (!positions.length) throw new Error("The selected portfolio has no positions.");
  if (positions.length > 100) throw new Error("Portfolio exceeds the 100 holding limit. Use an explicit subset with its original NAV weights.");
  const currencies = new Set([portfolio.currency]);
  for (const t of positions) {
    const category = t.metadata.assetCategory?.toUpperCase();
    if (category && !["STK", "STOCK", "EQUITY", "ETF", "FUND"].includes(category)) throw new Error(`${t.metadata.ticker}: ${category} position needs an explicit underlying exposure weight.`);
    currencies.add(t.metadata.currency);
    t.metadata.positions.filter(p => p.portfolio === portfolio.id).forEach(p => { if (p.currency) currencies.add(p.currency); });
  }
  const rates = new Map<string, number>([["USD", 1]]);
  const majorRates = new Map<string, number>([["USD", 1]]);
  const ensureRate = async (rawCurrency: string) => {
    const unit = resolveCurrencyUnit(rawCurrency);
    if (!unit.currency) throw new Error("Portfolio currency is missing.");
    let rate = majorRates.get(unit.currency);
    if (rate === undefined) {
      rate = await market.getExchangeRate(unit.currency);
      if (!Number.isFinite(rate) || rate <= 0) throw new Error(`FX unavailable for ${unit.currency}; weights were not estimated.`);
      majorRates.set(unit.currency, rate);
    }
    rates.set(rawCurrency, rate / unit.divisor);
  };
  for (const currency of currencies) await ensureRate(currency);
  const holdings: ExposureHolding[] = [];
  for (const ticker of positions) {
    const quote = await market.getQuote(ticker.metadata.ticker, ticker.metadata.exchange).catch(() => null);
    const currency = quote?.currency || ticker.metadata.currency;
    if (!rates.has(currency)) await ensureRate(currency);
    const metrics = getPortfolioPositionMetrics(ticker, portfolio.id, currency, {
      currency: portfolio.currency, convert: (value, from) => convertCurrency(value, from, portfolio.currency, rates),
    }, quote);
    const active = getPortfolioQuoteDisplay(metrics, quote);
    const value = resolvePortfolioMarketValue(metrics, active ? convertCurrency(active.price, currency, portfolio.currency, rates) : null);
    if (!value || !Number.isFinite(value.net)) throw new Error(`Market value unavailable for ${ticker.metadata.ticker}; no partial portfolio was reweighted.`);
    holdings.push({ symbol: publicTickerKey(ticker.metadata.ticker, ticker.metadata.exchange), weight: value.net / nav });
  }
  return holdings;
}
export function watchlistHoldings(tickers: TickerRecord[], id: string): ExposureHolding[] {
  const list = tickers.filter(t => t.metadata.watchlists.includes(id));
  if (!list.length) throw new Error("The selected watchlist is empty.");
  if (list.length > 100) throw new Error("Watchlist exceeds the 100 holding limit.");
  return list.map(t => ({ symbol: publicTickerKey(t.metadata.ticker, t.metadata.exchange), weight: 1 / list.length }));
}
