import type { DividendData } from "../dividend-yield/client";
import { fetchProviderDividendData } from "../dividend-yield/provider-client";
import { refusedLock } from "../shared/cloud-denied";
import { ApiRequestError } from "../../../api-client/errors";
import { regularSessionValuationPrice } from "../../../market-data/quotes/regular-session-valuation";
import { resolveTickerInstrumentKind } from "../../../tickers/instrument-kind";
import { mapWithConcurrency } from "../../../utils/concurrency";
import type { DataProvider } from "../../../types/data-provider";
import type { Quote } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";

/** Dividend reads `portfolio show` makes at once. */
const DIVIDEND_CONCURRENCY = 8;
/** How long `portfolio show` waits for every holding's dividends together before it prints without the rest. */
export const DIVIDEND_READ_DEADLINE_MS = 4_000;
/** How far `--drip` projects, in whole years. */
export const DRIP_MAX_YEARS = 5;
export const DRIP_DEFAULT_YEARS = 5;

/**
 * Why a holding's income is unknown: its cash history is incomplete, its
 * dividends could not be read (signed out, offline, or past the deadline),
 * or there is no exchange rate from its dividend currency.
 */
type IncomeGap =
  | { cause: "no-history" }
  | { cause: "unread"; why: "timed-out" | "sign-in" | "offline" | "failed" }
  | { cause: "fx"; currency: string };

/**
 * What a holding pays a year, per share: the trailing twelve months of cash
 * DVD reads (one payment per regular period, minor units such as ZAc and GBp
 * read in their major currency), with the price in the same currency for
 * reinvesting it. Null rate, with the gap, when it is unknown.
 */
export interface HoldingDividend {
  /** Trailing twelve-month cash per share, in `currency`; null when unknown. */
  perShare: number | null;
  currency: string | null;
  /** The share price in `currency`'s units, for buying shares with it; null when the quote cannot price it. */
  price: number | null;
  gap?: Exclude<IncomeGap, { cause: "fx" }>;
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
    return { perShare: null, currency: data.currency ?? null, price: data.price, gap: { cause: "no-history" } };
  }
  return { perShare: rate, currency: data.currency, price: data.price };
}

/** Why a read failed, in the words a reader can act on: a refused session, no connection, or anything else. */
function unreadWhy(error: unknown): "sign-in" | "offline" | "failed" {
  if (refusedLock(error)) return "sign-in";
  for (let current = error, depth = 0; current && depth < 4; depth += 1) {
    if (current instanceof ApiRequestError && current.status != null) return "failed";
    current = current instanceof Error ? current.cause : undefined;
  }
  // A request that never got an answer: no connection, DNS, a refused socket.
  return /fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN|Unable to connect|socket|offline/i.test(String(error instanceof Error ? error.message : error))
    ? "offline" : "failed";
}

export interface HoldingDividends {
  /** Each share and fund held, by ticker. */
  dividends: Map<string, HoldingDividend>;
  /** Whether the deadline passed with reads still out. */
  timedOut: boolean;
}

/**
 * The dividends of a portfolio's shares and funds, keyed by ticker: each
 * holding's cash history through the data provider, so a history read in the
 * last hours comes from the cache, measured as DVD measures it. Every read
 * shares one deadline; a holding not read by then, or whose read failed, has
 * an unknown rate, never a zero.
 */
export async function loadHoldingDividends(
  tickers: readonly TickerRecord[],
  quotes: ReadonlyMap<string, Quote>,
  provider: Pick<DataProvider, "getCorporateActions">,
  { deadlineMs = DIVIDEND_READ_DEADLINE_MS }: { deadlineMs?: number } = {},
): Promise<HoldingDividends> {
  const payers = tickers.filter((ticker) => paysDividends(ticker, quotes.get(ticker.metadata.ticker)));
  const dividends = new Map<string, HoldingDividend>();
  const getCorporateActions = provider.getCorporateActions?.bind(provider);
  // A source with no distribution histories at all (a custom provider) has no income to report, as a coin book has none.
  if (payers.length === 0 || !getCorporateActions) return { dividends, timedOut: false };
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => { timedOut = true; resolve("deadline"); }, deadlineMs);
  });
  const unread = (why: "timed-out" | "sign-in" | "offline" | "failed"): HoldingDividend =>
    ({ perShare: null, currency: null, price: null, gap: { cause: "unread", why } });
  try {
    await Promise.race([deadline, mapWithConcurrency(payers, DIVIDEND_CONCURRENCY, async (ticker) => {
      const symbol = ticker.metadata.ticker;
      if (timedOut) return;
      const quote = quotes.get(symbol);
      // The quote already read prices the cash; nothing asks for it again.
      const source = {
        getCorporateActions,
        getQuote: async () => { if (!quote) throw new Error("No quote"); return quote; },
      };
      const read = fetchProviderDividendData(source, symbol, regularSessionValuationPrice(quote), ticker.metadata.exchange ?? "", quote?.currency)
        .then(holdingDividend, (error: unknown) => unread(unreadWhy(error)));
      const result = await Promise.race([read, deadline]);
      if (result !== "deadline") dividends.set(symbol, result);
    })]);
  } finally {
    clearTimeout(timer);
  }
  for (const ticker of payers) {
    if (!dividends.has(ticker.metadata.ticker)) dividends.set(ticker.metadata.ticker, unread("timed-out"));
  }
  return { dividends, timedOut };
}

/** One row of the portfolio: a lot of a holding, its shares (negative for a short) and its value in the portfolio's currency. */
export interface IncomeLot {
  symbol: string;
  shares: number;
  value: number | null;
}

export interface PortfolioIncome {
  /** Each lot's income a year and its yield, in the order given; null when the lot has none to show. */
  lots: ({ income: number; yield: number | null } | null)[];
  /** The holdings whose income is unknown, and why. */
  gaps: Map<string, IncomeGap>;
  /** Holdings that pay or could pay dividends, and how many of them have a known income. */
  holdings: number;
  knownHoldings: number;
  /** The income of the holdings that have one; the whole portfolio's only when no holding is unknown. */
  knownIncome: number;
  totalIncome: number | null;
}

/**
 * A year of trailing dividends on each lot, in the portfolio's currency. A
 * short owes the dividend, so its income is negative and so is its yield,
 * which is over the lot's value however it is signed.
 */
export async function portfolioIncome(
  lots: readonly IncomeLot[],
  dividends: ReadonlyMap<string, HoldingDividend>,
  toBase: (value: number, currency: string) => Promise<number>,
): Promise<PortfolioIncome> {
  const read = await Promise.all(lots.map(async (lot): Promise<{ income: number } | { gap: IncomeGap } | null> => {
    const dividend = dividends.get(lot.symbol);
    if (!dividend) return null;
    if (dividend.gap || dividend.perShare == null || !dividend.currency) return { gap: dividend.gap ?? { cause: "no-history" } };
    const income = await toBase(lot.shares * dividend.perShare, dividend.currency);
    return Number.isFinite(income) ? { income } : { gap: { cause: "fx", currency: dividend.currency } };
  }));
  // In the order the lots are listed, so the note names them as the table does.
  const gaps = new Map<string, IncomeGap>();
  read.forEach((result, index) => { if (result && "gap" in result && !gaps.has(lots[index]!.symbol)) gaps.set(lots[index]!.symbol, result.gap); });
  // A holding with one lot unknown is unknown, whatever its other lots read.
  const incomes = read.map((result, index) => {
    const lot = lots[index]!;
    if (!result || !("income" in result) || gaps.has(lot.symbol)) return null;
    const value = lot.value != null && Number.isFinite(lot.value) && lot.value !== 0 ? Math.abs(lot.value) : null;
    return { income: result.income, yield: value != null ? (result.income / value) * 100 : null };
  });
  const known = new Set(lots.filter((_, index) => incomes[index]).map((lot) => lot.symbol));
  const knownIncome = incomes.reduce((sum, lot) => sum + (lot?.income ?? 0), 0);
  return {
    lots: incomes,
    gaps,
    holdings: new Set(lots.filter((lot) => dividends.has(lot.symbol)).map((lot) => lot.symbol)).size,
    knownHoldings: known.size,
    knownIncome,
    totalIncome: gaps.size > 0 ? null : knownIncome,
  };
}

const UNREAD_WORDS: Record<"timed-out" | "sign-in" | "offline" | "failed", (seconds: number) => string> = {
  "timed-out": (seconds) => `dividends not read within ${seconds}s`,
  "sign-in": () => "dividends not read without a Gloom sign-in",
  offline: () => "dividends not read (offline?)",
  failed: () => "dividends not read",
};

/**
 * The one line `portfolio show` says about income it cannot show, naming
 * each cause and its holdings: no dividend history, no exchange rate, or
 * dividends not read. Null when every holding's income is known.
 */
export function incomeGapNote(
  income: PortfolioIncome,
  { name, money, deadlineMs = DIVIDEND_READ_DEADLINE_MS }: { name: (symbols: string[]) => string; money: (value: number) => string; deadlineMs?: number },
): string | null {
  if (income.gaps.size === 0) return null;
  const groups = new Map<string, string[]>();
  for (const [symbol, gap] of income.gaps) {
    const key = gap.cause === "no-history" ? "no dividend history"
      : gap.cause === "fx" ? `no ${gap.currency} exchange rate`
      : UNREAD_WORDS[gap.why](Number((deadlineMs / 1000).toFixed(2)));
    groups.set(key, [...(groups.get(key) ?? []), symbol]);
  }
  const causes = [...groups].map(([cause, symbols]) => `${cause} for ${name(symbols)}`).join("; ");
  if (income.knownHoldings === 0) return `Income not shown: ${causes}.`;
  const others = income.knownHoldings;
  return `Income unavailable: ${causes}. The other ${others === 1 ? "holding pays" : `${others} holdings pay`} ${money(income.knownIncome)} a year.`;
}

/** `--years`: a whole number of years from 1 to DRIP_MAX_YEARS. */
export function parseDripYears(value: string | undefined): number {
  if (value == null) return DRIP_DEFAULT_YEARS;
  // Digits only: Number() would read "1e0", "0x3" and "3.0" as years too.
  const years = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
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
  /** Shares at the end of the year, after that year's dividends were reinvested; a short's stay as they are. */
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
 * A short owes each dividend in full instead: the same cost every year, with
 * nothing withheld and nothing reinvested.
 */
export function projectDrip(holding: DripHolding, { years, withholding }: { years: number; withholding: number }): DripYear[] {
  const short = holding.shares < 0;
  const keep = short ? 1 : 1 - withholding / 100;
  const projected: DripYear[] = [];
  let shares = holding.shares;
  for (let year = 1; year <= years; year += 1) {
    const grossIncome = shares * holding.perShare;
    const netIncome = grossIncome * keep;
    const addedShares = !short && holding.price > 0 ? netIncome / holding.price : 0;
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
