import type { QuoteBatchOptions, QuoteBatchResult, QuoteSubscriptionTarget } from "../types/data-provider";
import type { Quote } from "../types/financials";
import { isQuoteStaleForCurrentSession } from "../market-data/quotes/freshness";
import { dollarPairListing, fxFigureAsSent, quotedFxPair } from "../utils/currency-pair";
import { fxFreshUntil } from "../utils/fx-market-hours";
import { quoteObservation } from "../plugins/builtin/shared/report-freshness";
import { isUsableRate, type FxQuotedFigure } from "./fx-pair";

/** A listing a rate is read from, and whether its price is the rate's inverse. */
export interface FxQuoteLeg {
  symbol: string;
  invert: boolean;
}

/**
 * A pair's own listing, as markets quote it: EURJPY=X for EUR/JPY and,
 * inverted, for JPY/EUR; USDSGD=X for USD/SGD.
 */
export function fxPairListing(currency: string, baseCurrency: string): FxQuoteLeg {
  const [base, quote] = quotedFxPair(currency, baseCurrency, 1).pair.split("/") as [string, string];
  return { symbol: `${base}${quote}=X`, invert: base !== currency };
}

/** A currency's dollar pair, read as USD per unit: EURUSD=X, or USDJPY=X inverted. */
function dollarLeg(code: string): FxQuoteLeg {
  const symbol = dollarPairListing(code);
  return { symbol, invert: symbol.startsWith("USD") };
}

/** The rate `fx` answers with and the quotes behind it, each as `quote` reads it. */
export interface FxQuoteRate {
  /** `baseCurrency` per unit of `currency`, from the quotes' figures as sent: never rounded. */
  rate: number;
  /** The pair's own quote, or the two dollar pairs it is crossed from, each with its pair and figure as sent. */
  quotes: ({ symbol: string; quote: Quote } & FxQuotedFigure)[];
  /** Crossed through the dollar: the pair has no quote of its own. */
  viaUsd: boolean;
  /** A metal with no spot quote, priced from its front-month future instead: the future's listing (GC=F). */
  derivedFrom?: string;
}

/**
 * The front-month future a metal with no spot quote is priced from, in USD per
 * troy ounce: COMEX gold and silver, NYMEX platinum and palladium.
 */
export const METAL_FRONT_MONTH: Readonly<Record<string, string>> = { XAU: "GC=F", XAG: "SI=F", XPT: "PL=F", XPD: "PA=F" };

/** "Gold", for the line that says a metal's rate is derived from its future. */
export const METAL_NAMES: Readonly<Record<string, string>> = { XAU: "Gold", XAG: "Silver", XPT: "Platinum", XPD: "Palladium" };

export interface FxQuoteMiss {
  /** The currencies no quote priced. */
  missing: string[];
  /** The reasons the quotes that did not come back gave, first the pair's own. */
  errors: unknown[];
}

/** The figure a leg's quote was sent as (EURJPY=X 177.811), or null for none. */
function legFigure(quote: Quote | null | undefined): number | null {
  const price = quote?.price;
  return isUsableRate(price) ? fxFigureAsSent(price) : null;
}

function legRate(leg: FxQuoteLeg, quote: Quote | null | undefined): number | null {
  const figure = legFigure(quote);
  if (figure == null) return null;
  const rate = leg.invert ? 1 / figure : figure;
  return isUsableRate(rate) ? rate : null;
}

/** A leg's quote with its pair as markets write it (EURJPY=X is EUR/JPY) and its figure as sent. */
function quotedLeg(leg: FxQuoteLeg, quote: Quote): { symbol: string; quote: Quote } & FxQuotedFigure {
  return { symbol: leg.symbol, quote, pair: `${leg.symbol.slice(0, 3)}/${leg.symbol.slice(3, 6)}`, figure: legFigure(quote)! };
}

/**
 * The rate of `currency` in `baseCurrency` from the quotes `quote` and the FX
 * board read, in one batch: the pair's own quote (EURJPY=X for EUR/JPY),
 * else, for a pair with no quote or one that went stale while both dollar
 * pairs are current, the cross of the dollar pairs (EURUSD=X and USDJPY=X),
 * said as such. A pair with a dollar side is its own dollar pair. Null for a
 * currency priced in itself; the currencies no quote priced when neither
 * reading has a price.
 */
export async function readFxQuoteRate(
  currency: string,
  baseCurrency: string,
  getQuotesBatch: (targets: QuoteSubscriptionTarget[], options?: QuoteBatchOptions) => Promise<QuoteBatchResult[]>,
  options: { forceRefresh?: boolean; now?: number } = {},
): Promise<FxQuoteRate | FxQuoteMiss | null> {
  if (currency === baseCurrency) return null;
  const now = options.now ?? Date.now();
  const own = fxPairListing(currency, baseCurrency);
  const crossed = currency !== "USD" && baseCurrency !== "USD";
  const legs = crossed ? [dollarLeg(currency), dollarLeg(baseCurrency)] : [];
  const asked = [own, ...legs];
  const results = await getQuotesBatch(
    asked.map((leg) => ({ symbol: leg.symbol, exchange: "" })),
    { forceRefresh: options.forceRefresh === true, revalidate: true },
  );
  const resultOf = (leg: FxQuoteLeg, index: number) => results.find((result) => result.target.symbol === leg.symbol) ?? results[index];
  const read = asked.map((leg, index) => {
    const result = resultOf(leg, index);
    const quote = result?.quote ?? null;
    return { leg, quote, rate: legRate(leg, quote), error: result?.error };
  });
  const [pair, from, into] = read as [typeof read[number], ...typeof read];
  const current = (entry: typeof read[number] | undefined) => entry?.rate != null && !isQuoteStaleForCurrentSession(entry.quote!, now);
  const legsCurrent = crossed && current(from) && current(into);
  if (pair.rate != null && (!legsCurrent || current(pair))) {
    return { rate: pair.rate, quotes: [quotedLeg(pair.leg, pair.quote!)], viaUsd: false };
  }
  if (crossed && from?.rate != null && into?.rate != null) {
    return {
      rate: from.rate / into.rate,
      quotes: [quotedLeg(from.leg, from.quote!), quotedLeg(into.leg, into.quote!)],
      viaUsd: true,
    };
  }
  const missing = crossed
    ? [currency, baseCurrency].filter((_code, index) => read[index + 1]?.rate == null)
    : [currency === "USD" ? baseCurrency : currency];
  const miss = { missing, errors: read.flatMap((entry) => entry.rate == null && entry.error != null ? [entry.error] : []) };
  return (await metalFromFuture(currency, baseCurrency, read, getQuotesBatch, options.forceRefresh === true)) ?? miss;
}

/**
 * A metal with no spot quote (gold in lira), priced from its front-month
 * future in dollars and, for another currency, the dollar pair already read:
 * derived, and said to be. Null when neither side is a metal or a price is missing.
 */
async function metalFromFuture(
  currency: string,
  baseCurrency: string,
  read: ReadonlyArray<{ leg: FxQuoteLeg; quote: Quote | null; rate: number | null }>,
  getQuotesBatch: (targets: QuoteSubscriptionTarget[], options?: QuoteBatchOptions) => Promise<QuoteBatchResult[]>,
  forceRefresh: boolean,
): Promise<FxQuoteRate | null> {
  const metal = [currency, baseCurrency].find((code) => METAL_FRONT_MONTH[code]);
  const other = metal === currency ? baseCurrency : currency;
  if (!metal || METAL_FRONT_MONTH[other]) return null;
  const future = METAL_FRONT_MONTH[metal]!;
  const [result] = await getQuotesBatch([{ symbol: future, exchange: "" }], { forceRefresh, revalidate: true });
  const quote = result?.quote ?? null;
  const ounce = quote?.currency && quote.currency !== "USD" ? null : legFigure(quote);
  if (ounce == null) return null;
  // The other side's dollar pair, as the cross already read it: USD per lira.
  const dollar = other === "USD" ? null : read.find((entry) => entry.leg.symbol === dollarPairListing(other));
  if (other !== "USD" && dollar?.rate == null) return null;
  const usdPerOther = dollar?.rate ?? 1;
  const metalRate = ounce / usdPerOther;
  return {
    rate: metal === currency ? metalRate : 1 / metalRate,
    quotes: [
      { symbol: future, quote: quote!, pair: `${metal}/USD`, figure: ounce },
      ...(dollar ? [quotedLeg(dollar.leg, dollar.quote!)] : []),
    ],
    viaUsd: other !== "USD",
    derivedFrom: future,
  };
}

/** How long past its feed's delay a weekday FX rate stays current, counted while the FX market trades. */
const FX_STALE_AFTER_DELAY_MS = 15 * 60_000;

/**
 * Whether an FX quote has aged past its feed's delay and fifteen minutes,
 * counting only the hours the FX market trades (`fxFreshUntil`): Friday's
 * close stays current over the weekend, a rate that stopped on a weekday
 * goes stale, whatever the service said of it.
 */
function fxQuoteAgedOut(observation: { updatedAt: number; delayMinutes?: number }, now = Date.now()): boolean {
  if (!Number.isFinite(observation.updatedAt)) return false;
  return fxFreshUntil(observation.updatedAt, (observation.delayMinutes ?? 0) * 60_000 + FX_STALE_AFTER_DELAY_MS) <= now;
}

/**
 * The one observation a rate is dated by, as `quote` dates a quote: the
 * pair's own quote, or for a cross the older of its two, stale when either
 * is (as the service says, or aged out: `fxQuoteAgedOut`) and as held back as
 * the more delayed.
 */
export function fxQuoteRateObservation(rate: FxQuoteRate, now = Date.now()): ReturnType<typeof quoteObservation> {
  const observations = rate.quotes.map(({ quote }) => quoteObservation(quote, now));
  const oldest = observations.reduce((older, observation) => observation.updatedAt < older.updatedAt ? observation : older);
  const delays = observations.flatMap((observation) => observation.delayMinutes ?? []);
  return {
    ...oldest,
    stale: observations.some((observation) => observation.stale === true || fxQuoteAgedOut(observation, now)),
    ...(delays.length > 0 ? { delayMinutes: Math.max(...delays) } : {}),
  };
}
