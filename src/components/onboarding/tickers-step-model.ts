import type { OnboardingProgress } from "../../types/config";
import type { InstrumentSearchResult } from "../../types/instrument";
import type { TickerRecord } from "../../types/ticker";
import { DESK_KEYS, type DeskKey } from "../../layout/desk-keys";
import type { FirstRunTickerSeed } from "./first-run-workspace";

/** The most names "Which tickers do you follow?" takes, as the Desks step takes three desks. */
export const MAX_TICKER_PICKS = 3;
/** Rows the step lists: the picks searched for, then the suggestions. */
export const TICKER_STEP_ROWS = 6;

/**
 * One name on the step: a suggestion, a saved ticker search found, or a
 * search result, which is saved through the usual search upsert once the
 * step closes.
 */
export interface TickerPick {
  symbol: string;
  name: string;
  seed?: FirstRunTickerSeed;
  ticker?: TickerRecord;
  result?: InstrumentSearchResult;
}

const stock = (ticker: string, name: string, exchange = "NASDAQ"): FirstRunTickerSeed => (
  { ticker, name, exchange, currency: "USD", assetCategory: "STK" }
);
const fund = (ticker: string, name: string, exchange = "NYSEARCA"): FirstRunTickerSeed => (
  { ticker, name, exchange, currency: "USD", assetCategory: "ETF" }
);
const future = (ticker: string, name: string, exchange: string): FirstRunTickerSeed => (
  { ticker, name, exchange, currency: "USD", assetCategory: "FUTURE" }
);
const pair = (ticker: string, name: string, currency: string): FirstRunTickerSeed => (
  { ticker, name, exchange: "CCY", currency, assetCategory: "CURRENCY" }
);

const SPY = fund("SPY", "SPDR S&P 500 ETF");
const QQQ = fund("QQQ", "Invesco QQQ Trust", "NASDAQ");
const IWM = fund("IWM", "iShares Russell 2000 ETF");
const TLT = fund("TLT", "iShares 20+ Year Treasury Bond ETF", "NASDAQ");
const NVDA = stock("NVDA", "NVIDIA Corp.");
const AAPL = stock("AAPL", "Apple Inc.");
const TSLA = stock("TSLA", "Tesla Inc.");
const AMD = stock("AMD", "Advanced Micro Devices");
const PLTR = stock("PLTR", "Palantir Technologies");
const GOLD = future("GC=F", "Gold", "CMX");

/**
 * What each desk's traders most often follow, in the order offered. Picks of
 * several desks take turns, so each desk is offered its first names.
 */
const DESK_SUGGESTIONS: Record<DeskKey, readonly FirstRunTickerSeed[]> = {
  equities: [NVDA, AAPL, stock("MSFT", "Microsoft Corp."), PLTR, AMD, stock("AVGO", "Broadcom Inc.")],
  options: [SPY, QQQ, TSLA, NVDA, AMD, IWM],
  futures: [
    future("ES=F", "E-Mini S&P 500", "CME"),
    future("NQ=F", "E-Mini Nasdaq 100", "CME"),
    future("CL=F", "WTI Crude Oil", "NYM"),
    GOLD,
    future("NG=F", "Natural Gas", "NYM"),
    future("SI=F", "Silver", "CMX"),
  ],
  rates: [
    TLT,
    fund("IEF", "iShares 7-10 Year Treasury Bond ETF", "NASDAQ"),
    fund("SHY", "iShares 1-3 Year Treasury Bond ETF", "NASDAQ"),
    fund("HYG", "iShares iBoxx $ High Yield Corporate Bond ETF"),
    fund("LQD", "iShares iBoxx $ Investment Grade Corporate Bond ETF"),
    fund("TIP", "iShares TIPS Bond ETF"),
  ],
  fx: [
    pair("EURUSD=X", "EUR/USD", "USD"),
    pair("USDJPY=X", "USD/JPY", "JPY"),
    pair("GBPUSD=X", "GBP/USD", "USD"),
    fund("UUP", "Invesco DB US Dollar Index Bullish Fund"),
    GOLD,
    TLT,
  ],
  active: [SPY, QQQ, IWM, TSLA, NVDA, AMD],
};
/** Without a desk: the names new users most often follow. */
const GENERAL_SUGGESTIONS: readonly FirstRunTickerSeed[] = [NVDA, AAPL, TSLA, PLTR, AMD, SPY];

function isDeskKey(value: string): value is DeskKey {
  return (DESK_KEYS as readonly string[]).includes(value);
}

/** The suggestions for the desks picked, in pick order, taking turns between desks. */
export function tickerSuggestions(desks: readonly string[] | undefined): FirstRunTickerSeed[] {
  const lists = (desks ?? []).filter(isDeskKey).map((desk) => DESK_SUGGESTIONS[desk]);
  if (lists.length === 0) return [...GENERAL_SUGGESTIONS];
  const offered = new Map<string, FirstRunTickerSeed>();
  const longest = Math.max(...lists.map((list) => list.length));
  for (let index = 0; index < longest && offered.size < TICKER_STEP_ROWS; index += 1) {
    for (const list of lists) {
      const seed = list[index];
      if (seed && !offered.has(seed.ticker) && offered.size < TICKER_STEP_ROWS) offered.set(seed.ticker, seed);
    }
  }
  return [...offered.values()];
}

/**
 * The step's rows with no search typed: the picks search found first (a
 * suggestion picked keeps its place), then the suggestions. Past the rows
 * the step has, the last suggestions not picked give way, so every pick
 * stays in view.
 */
export function tickerStepRows(picks: readonly TickerPick[], suggestions: readonly FirstRunTickerSeed[]): TickerPick[] {
  const suggested = new Set(suggestions.map((seed) => seed.ticker));
  const picked = new Set(picks.map((pick) => pick.symbol));
  const searched = picks.filter((pick) => !suggested.has(pick.symbol));
  const offered = suggestions.map((seed) => picks.find((pick) => pick.symbol === seed.ticker) ?? { symbol: seed.ticker, name: seed.name, seed });
  const rows = [...searched, ...offered];
  for (let index = rows.length - 1; index >= 0 && rows.length > TICKER_STEP_ROWS; index -= 1) {
    if (!picked.has(rows[index]!.symbol)) rows.splice(index, 1);
  }
  return rows;
}

/** Picks or unpicks a name; a fourth pick is ignored, as the Desks step ignores a fourth desk. */
export function toggleTickerPick(picks: readonly TickerPick[], pick: TickerPick): TickerPick[] {
  if (picks.some((entry) => entry.symbol === pick.symbol)) return picks.filter((entry) => entry.symbol !== pick.symbol);
  return picks.length < MAX_TICKER_PICKS ? [...picks, pick] : [...picks];
}

/**
 * Whether this first run would show "Which tickers do you follow?", so asks
 * first_run_tickers for its arm: a first run that left "What do you hold?"
 * holding nothing on this build. A holding already names a ticker of the
 * user's and a broker brings several; Run Setup Again, an install that
 * finished setup and one that began it on an earlier build never ask.
 */
export function asksFirstRunTickers(progress: OnboardingProgress): boolean {
  return progress.asksTickers === true
    && progress.rerun !== true
    && progress.path !== "broker"
    && (progress.positionsImported ?? 0) === 0;
}
