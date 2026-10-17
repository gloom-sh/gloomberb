import { fetchDividendData, type DividendData } from "../dividend-yield/client";
import { regularSessionValuationPrice } from "../../../market-data/quotes/regular-session-valuation";
import { resolveTickerInstrumentKind } from "../../../tickers/instrument-kind";
import { mapWithConcurrency } from "../../../utils/concurrency";
import type { Quote } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";

/** Dividend reads `portfolio show` makes at once. */
const DIVIDEND_CONCURRENCY = 6;
/** How far `--drip` projects, in whole years. */
export const DRIP_MAX_YEARS = 5;
export const DRIP_DEFAULT_YEARS = 5;

/**
 * What a holding pays a year, per share: the trailing twelve months of cash
 * DVD reads (one payment per regular period, minor units such as ZAc and GBp
 * read in their major currency), with the price in the same currency for
 * reinvesting it. Null rate when the history could not be read.
 */
export interface HoldingDividend {
  /** Trailing twelve-month cash per share, in `currency`; null when unknown. */
  perShare: number | null;
  currency: string | null;
  /** The share price in `currency`'s units, for buying shares with it; null when the quote cannot price it. */
  price: number | null;
  /** Why the rate is unknown. */
  error?: string;
}

/** Listings that pay dividends: shares and funds. Coins, contracts, bonds and indices have no dividend history. */
function paysDividends(ticker: TickerRecord, quote: Quote | undefined): boolean {
  const kind = resolveTickerInstrumentKind(ticker, quote ? { quote } : null);
  return kind === "equity" || kind === "fund";
}

/** One holding's dividend from what DVD read: the trailing rate only when the cash history is whole. */
function holdingDividend(data: Pick<DividendData, "metrics" | "currency" | "price" | "historyError">): HoldingDividend {
  const rate = data.metrics.trailingRate;
  if (data.historyError || rate == null || !Number.isFinite(rate) || !data.currency) {
    return { perShare: null, currency: data.currency ?? null, price: data.price, error: data.historyError ?? "Dividend history unavailable" };
  }
  return { perShare: rate, currency: data.currency, price: data.price };
}

/**
 * The dividends of a portfolio's shares and funds, keyed by ticker, read
 * through DVD's path at the price each holding is quoted at. A failed read is
 * an unknown rate, never a zero.
 */
export async function loadHoldingDividends(
  tickers: readonly TickerRecord[],
  quotes: ReadonlyMap<string, Quote>,
  load: typeof fetchDividendData = fetchDividendData,
): Promise<Map<string, HoldingDividend>> {
  const payers = tickers.filter((ticker) => paysDividends(ticker, quotes.get(ticker.metadata.ticker)));
  const dividends = new Map<string, HoldingDividend>();
  await mapWithConcurrency(payers, DIVIDEND_CONCURRENCY, async (ticker) => {
    const quote = quotes.get(ticker.metadata.ticker);
    try {
      const data = await load(ticker.metadata.ticker, regularSessionValuationPrice(quote), ticker.metadata.exchange ?? "", quote?.currency);
      dividends.set(ticker.metadata.ticker, holdingDividend(data));
    } catch (error) {
      dividends.set(ticker.metadata.ticker, { perShare: null, currency: null, price: null, error: error instanceof Error ? error.message : String(error) });
    }
  });
  return dividends;
}

/** `--years`: a whole number of years from 1 to DRIP_MAX_YEARS. */
export function parseDripYears(value: string | undefined): number {
  if (value == null) return DRIP_DEFAULT_YEARS;
  const years = Number(value.trim());
  if (!Number.isInteger(years) || years < 1 || years > DRIP_MAX_YEARS) {
    throw new Error(`--years must be a whole number from 1 to ${DRIP_MAX_YEARS}, not ${JSON.stringify(value)}.`);
  }
  return years;
}

/** `--withholding`: the tax withheld from each dividend, in percent: 15, 15%, 27.5 or 27,5. */
export function parseWithholding(value: string | undefined): number {
  if (value == null) return 0;
  const text = value.trim().replace(/%$/, "").trim().replace(",", ".");
  const percent = /^\d+(\.\d+)?$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error(`--withholding is a percent from 0 to 100, such as --withholding 15, not ${JSON.stringify(value)}.`);
  }
  return percent;
}

/** One holding to project: its shares and dividend, and the rate that turns its dividend currency into the portfolio's. */
export interface DripHolding {
  symbol: string;
  shares: number;
  /** Trailing twelve-month cash per share, in the dividend currency. */
  perShare: number;
  /** Share price in the dividend currency. */
  price: number;
  /** Portfolio currency per unit of the dividend currency. */
  rate: number;
}

export interface DripYear {
  year: number;
  /** Shares at the end of the year, after that year's dividends were reinvested. */
  shares: number;
  /** Shares those dividends bought. */
  addedShares: number;
  /** Dividends before and after withholding, and the tax withheld, in the dividend currency. */
  grossIncome: number;
  withheld: number;
  netIncome: number;
  /** Net income and the holding's value at year end, in the portfolio's currency. */
  netIncomeBase: number;
  valueBase: number;
}

/**
 * Dividend reinvestment, year by year: each year the shares held pay the
 * trailing dividend per share, the withholding comes off, and what is left
 * buys shares at the current price once, at the year's end. Dividend, price
 * and exchange rate are held where they are today; nothing grows or moves.
 */
export function projectDrip(holding: DripHolding, { years, withholding }: { years: number; withholding: number }): DripYear[] {
  const keep = 1 - withholding / 100;
  const projected: DripYear[] = [];
  let shares = holding.shares;
  for (let year = 1; year <= years; year += 1) {
    const grossIncome = shares * holding.perShare;
    const netIncome = grossIncome * keep;
    const addedShares = holding.price > 0 ? netIncome / holding.price : 0;
    shares += addedShares;
    projected.push({
      year,
      shares,
      addedShares,
      grossIncome,
      withheld: grossIncome - netIncome,
      netIncome,
      netIncomeBase: netIncome * holding.rate,
      valueBase: shares * holding.price * holding.rate,
    });
  }
  return projected;
}
