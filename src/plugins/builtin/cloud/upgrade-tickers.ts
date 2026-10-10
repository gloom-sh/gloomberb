/**
 * The tickers an upgrade surface may name for the `upgrade_personalized`
 * experiment: the account's own holdings, or with none, the tickers it chose
 * to watch, read from this device's portfolios and watchlists. They stay on
 * the device; nothing here is sent anywhere.
 */
import { tf } from "../../../i18n";
import type { TickerFinancials } from "../../../types/financials";
import type { TickerRecord, Watchlist } from "../../../types/ticker";
import { isUsListingExchange } from "../../../utils/exchanges";
import { getPortfolioPositionValue } from "../kelly-sizer/portfolio";
import { STARTER_SYMBOLS } from "./starter-symbols";

const UPGRADE_TICKER_LIMIT = 3;
/** One to five letters and an optional class letter: BRK.B, never BTC-USD, ES=F, ^GSPC, SHOP.TO or 7203. */
const PLAIN_TICKER = /^[A-Z]{1,5}(?:\.[A-Z])?$/;
/** Every candidate is a US listing, so values compare in dollars without a rate. */
const DOLLARS = new Map([["USD", 1]]);
/** Stocks and exchange-traded funds; not mutual funds, which have no intraday quote. */
const LISTED_TYPES = new Set(["", "STK", "EQUITY", "COMMONSTOCK", "ADR", "DEPOSITARYRECEIPT", "ETF", "ETP", "CEF", "CLOSEDEND", "CLOSEDENDFUND"]);

/** A stock or fund on a US listing exchange (not OTC), priced in dollars. */
function isUsListedStockOrFund(ticker: TickerRecord): boolean {
  const contract = ticker.metadata.broker_contracts?.[0];
  const type = (contract?.secType ?? ticker.metadata.assetCategory ?? "").trim().toUpperCase().replace(/[\s_-]/g, "");
  const currency = (contract?.currency ?? ticker.metadata.currency ?? "").trim().toUpperCase();
  return LISTED_TYPES.has(type)
    && (currency === "USD" || currency === "")
    && [contract?.primaryExchange, contract?.exchange, ticker.metadata.exchange].some((exchange) => isUsListingExchange(exchange));
}

/**
 * The symbol when it is a plain US stock or fund someone can get a real-time
 * quote for: not cash, an option, a future, a crypto pair or a foreign listing.
 */
function plainSymbol(ticker: TickerRecord): string | null {
  const symbol = ticker.metadata.ticker.trim().toUpperCase();
  if (!PLAIN_TICKER.test(symbol) || !isUsListedStockOrFund(ticker)) return null;
  // A contract multiplier means the holding is an option or a future on it.
  if (ticker.metadata.positions.some((position) => (position.multiplier ?? 1) !== 1)) return null;
  return symbol;
}

interface Holding {
  /** The market value is known on this device: a quote it already has, or the broker's own value. */
  priced: boolean;
  value: number;
}

/**
 * Gross market value of the shares held, valued like the portfolio pane from
 * what the device already has; null when none are held. Without a quote or a
 * broker value it falls back to what was paid, and says so with `priced`.
 */
function heldValue(ticker: TickerRecord, financials: TickerFinancials | undefined): Holding | null {
  const held = ticker.metadata.positions.filter((position) => position.shares !== 0);
  if (held.length === 0) return null;
  const value = getPortfolioPositionValue({
    ticker,
    financials: financials ?? null,
    portfolioId: null,
    baseCurrency: "USD",
    exchangeRates: DOLLARS,
  });
  if (Number.isFinite(value)) return { priced: true, value };
  const cost = held.reduce((total, position) => total + Math.abs(position.shares * (position.avgCost ?? 0)), 0);
  return { priced: false, value: Number.isFinite(cost) ? cost : 0 };
}

/**
 * Up to three tickers, or none for the generic copy:
 * - the biggest holdings across every portfolio, those with a known market
 *   value first by that value, then any the device cannot value yet by cost;
 * - with nothing held, the first watchlist tickers in list order (lists in
 *   their order, each sorted by ticker as the pane shows it). Team lists and
 *   the names the app seeds on first run are skipped: nobody here picked them.
 */
export function selectUpgradeTickers(
  tickers: Iterable<TickerRecord>,
  financials: ReadonlyMap<string, TickerFinancials>,
  watchlists: readonly Watchlist[],
): string[] {
  const records = [...tickers];
  const holdings = new Map<string, Holding>();
  for (const ticker of records) {
    const symbol = plainSymbol(ticker);
    if (!symbol) continue;
    const holding = heldValue(ticker, financials.get(ticker.metadata.ticker));
    if (holding) holdings.set(symbol, holding);
  }
  if (holdings.size > 0) {
    return [...holdings]
      .sort(([leftSymbol, left], [rightSymbol, right]) => (
        Number(right.priced) - Number(left.priced)
        || right.value - left.value
        || leftSymbol.localeCompare(rightSymbol)
      ))
      .slice(0, UPGRADE_TICKER_LIMIT)
      .map(([symbol]) => symbol);
  }

  const picked: string[] = [];
  for (const watchlist of watchlists) {
    if (watchlist.teamId) continue;
    const members = records
      .filter((ticker) => ticker.metadata.watchlists.includes(watchlist.id))
      .sort((left, right) => left.metadata.ticker.localeCompare(right.metadata.ticker));
    for (const ticker of members) {
      const symbol = plainSymbol(ticker);
      if (!symbol || STARTER_SYMBOLS.has(symbol) || picked.includes(symbol)) continue;
      picked.push(symbol);
      if (picked.length === UPGRADE_TICKER_LIMIT) return picked;
    }
  }
  return picked;
}

/** "NVDA", "NVDA and AAPL", "NVDA, AAPL and MSFT". */
export function upgradeTickerList(tickers: readonly string[]): string {
  const [first = "", second, third] = tickers;
  if (third) return tf("{first}, {second} and {third}", { first, second: second!, third });
  if (second) return tf("{first} and {second}", { first, second });
  return first;
}
