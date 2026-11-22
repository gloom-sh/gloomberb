import type { DataProvider } from "../../../types/data-provider";
import { chunked } from "../../../utils/concurrency";
import type { Quote } from "../../../types/financials";
import { extendedPrintSession, getActiveQuoteDisplay } from "../../../market-data/market/status";
import { isPenceQuotedLine } from "../../../market-data/market/format";
import { isQuoteStaleForCurrentSession } from "../../../market-data/quotes/freshness";
import { canonicalExchange } from "../../../utils/exchanges";
import { futuresContractByWord } from "../../../market-data/futures-board";
import { isFuturesInstrument } from "../../../market-data/futures-contract";
import { readMove } from "./move";
import type { AlertRule } from "./types";
import { createBaseConverter } from "../../../cli/base-converter";
import { baseConversionLabel } from "../../../cli/base-conversion-label";
import { alertPriceWithCurrency } from "./price-text";

export function normalizeAlertSymbol(value: string | null | undefined): string {
  return value?.trim().toUpperCase() ?? "";
}

export function createQuoteErrorMessage(
  symbol: string,
  error?: unknown,
): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return `No quote found for "${symbol}".`;
}

export async function resolveAlertQuote(
  marketData: Pick<DataProvider, "getQuote">,
  symbol: string,
  exchange = "",
): Promise<Quote> {
  return alertQuote(await marketData.getQuote(symbol, exchange), symbol);
}

/** Listings quoted in one request of the alert poll: as many as a signed-out caller's batch may read. */
const ALERT_QUOTE_BATCH = 100;

/**
 * Quotes for many listings, a hundred to a request and one request after
 * another, each read as `resolveAlertQuote` reads one: five hundred move
 * rules are five requests a check, not five hundred. A listing with no
 * quote gets why, as a string. Without batches, each is asked on its own.
 */
export async function resolveAlertQuotes(
  marketData: Pick<DataProvider, "getQuote" | "getQuotesBatch">,
  targets: ReadonlyArray<{ symbol: string; exchange: string }>,
): Promise<Array<Quote | string>> {
  const asked = targets.map((target) => ({ symbol: target.symbol, exchange: target.exchange }));
  const one = (target: { symbol: string; exchange: string }) => resolveAlertQuote(marketData, target.symbol, target.exchange)
    .catch((error: unknown) => createQuoteErrorMessage(target.symbol, error));
  if (!marketData.getQuotesBatch) return Promise.all(asked.map(one));
  const answers: Array<Quote | string> = [];
  for (const chunk of chunked(asked, ALERT_QUOTE_BATCH)) {
    const results = await marketData.getQuotesBatch(chunk).catch((error: unknown) => chunk.map((target) => ({ target, quote: null, error })));
    answers.push(...chunk.map((target) => {
      const result = results.find((entry) => entry.target === target)
        ?? results.find((entry) => entry.target.symbol === target.symbol && (entry.target.exchange ?? "") === target.exchange);
      if (!result?.quote) return createQuoteErrorMessage(target.symbol, result?.error instanceof Error ? result.error : result?.error ? new Error(String(result.error)) : undefined);
      try {
        return alertQuote(result.quote, target.symbol);
      } catch (error) {
        return createQuoteErrorMessage(target.symbol, error);
      }
    }));
  }
  return answers;
}

/** A quote an alert may be judged on, at the price its active session shows; throws for a stale one or one with no price. */
export function alertQuote(quote: Quote, symbol: string): Quote {
  // A last known price is not the price now: it must neither trigger an alert nor set its baseline.
  if (isQuoteStaleForCurrentSession(quote)) throw new Error(`The quote for "${symbol}" is stale.`);
  const display = getActiveQuoteDisplay(quote);
  if (!display || !Number.isFinite(display.price)) {
    throw new Error(`No quote found for "${symbol}".`);
  }
  return {
    ...quote,
    price: display.price,
    change: display.change ?? Number.NaN,
    changePercent: display.changePercent ?? Number.NaN,
  };
}

export function alertQuoteListingFields(quote: Quote): Pick<AlertRule, "lastQuoteCurrency" | "lastQuoteExchange" | "lastQuotePence"> {
  const exchange = quote.listingExchangeName || quote.exchangeName;
  return {
    ...(quote.currency ? { lastQuoteCurrency: quote.currency } : {}),
    ...(exchange ? { lastQuoteExchange: canonicalExchange(exchange) } : {}),
    lastQuotePence: isPenceQuotedLine(quote) || undefined,
  };
}

export function quoteAlertFields(
  quote: Quote,
  checkedAt = Date.now(),
): Pick<
  AlertRule,
  | "lastCheckedPrice"
  | "lastCheckedAt"
  | "lastQuoteUpdatedAt"
  | "lastQuoteSource"
  | "lastQuoteProviderId"
  | "lastQuoteCurrency"
  | "lastQuoteExchange"
  | "lastQuotePence"
  | "lastQuoteSession"
> & { lastCheckError?: undefined } {
  return {
    lastCheckedPrice: quote.price,
    lastCheckedAt: checkedAt,
    lastQuoteUpdatedAt: quote.lastUpdated,
    lastQuoteSource: quote.dataSource,
    lastQuoteProviderId: quote.providerId,
    ...alertQuoteListingFields(quote),
    // An after-hours print says so wherever the reading is shown, as `quote` names it beside Last.
    lastQuoteSession: extendedPrintSession(quote, quote.price) ?? undefined,
    lastCheckError: undefined,
  };
}

/** How far past the check that read it a last print's time may be, for clocks apart, and still be one. */
const PRINT_CLOCK_SKEW_MS = 5 * 60_000;

/**
 * Whether a quote printed before the one an alert was last checked on: a
 * cached copy older than what the alert has already seen (at launch, a quote
 * read minutes before the app last closed). It must neither set the alert off
 * nor become its last reading. A last print timed past the check that read
 * it, beyond clocks apart, says nothing, so it holds no quote back.
 */
export function printedBeforeLastCheck(
  alert: Pick<AlertRule, "lastQuoteUpdatedAt" | "lastCheckedAt">,
  quote: Pick<Quote, "lastUpdated">,
): boolean {
  const seen = alert.lastQuoteUpdatedAt;
  const printed = quote.lastUpdated;
  if (seen == null || printed == null || !Number.isFinite(seen) || !Number.isFinite(printed)) return false;
  if (alert.lastCheckedAt != null && seen > alert.lastCheckedAt + PRINT_CLOCK_SKEW_MS) return false;
  return printed < seen;
}

/**
 * A move rule's fields from a quote: those a price rule takes, with the
 * reading the quote's move (in percent) and the close it is measured from.
 */
export function moveQuoteFields(quote: Quote, checkedAt = Date.now()): ReturnType<typeof quoteAlertFields> & Pick<AlertRule, "lastMoveBasis"> {
  const reading = readMove(quote, checkedAt);
  return { ...quoteAlertFields(quote, checkedAt), lastCheckedPrice: reading?.percent, lastMoveBasis: reading?.basis };
}

export function quoteErrorAlertFields(
  error: string,
  checkedAt = Date.now(),
): Pick<AlertRule, "lastCheckedAt" | "lastCheckError"> {
  return {
    lastCheckedAt: checkedAt,
    lastCheckError: error,
  };
}

/** How many times the last price a target may be, either way, before it reads as a typo or another instrument's price. */
const MAX_TARGET_RATIO = 10;

/** A price as typed or quoted, never in exponent form: 85,000, 37.35, 0.0000001234. */
const priceText = (value: number) => value.toLocaleString("en-US", Math.abs(value) >= 1
  ? { maximumFractionDigits: 2 }
  : { maximumSignificantDigits: 4 });

/**
 * "GOLD is Gold.com, Inc.; for Gold, the future is GC=F (gloom alerts add
 * GC=F below 3700).": a commodity's word typed bare that a security trades as
 * (GOLD is Gold.com, WTI is W&T Offshore), with the future it may have meant,
 * as `quote` says it. Null for any other symbol, a venue named, or a future.
 */
export function commodityFutureNote(
  typed: string,
  quote: Pick<Quote, "name" | "instrumentType">,
  retry: ((symbol: string) => string | null) | null = null,
): string | null {
  const symbol = typed.trim().toUpperCase();
  if (symbol.includes(":")) return null;
  const contract = futuresContractByWord(symbol);
  if (!contract || isFuturesInstrument(symbol, quote.instrumentType)) return null;
  const command = retry?.(contract.symbol);
  return `${symbol} is ${quote.name?.trim() || "a security"}; for ${contract.name}, the future is ${contract.symbol}${command ? ` (${command})` : ""}.`;
}

/**
 * Why a price target is refused: more than ten times the last price, or under
 * a tenth of it, which is a slip or another instrument's price (bitcoin's,
 * typed on the BTC fund). `coinNote` is the note `quote` gives a bare coin
 * ticker on a listing that is not the coin, which says what to use instead.
 * Null when the target is near enough, or there is no positive last price to
 * measure it against.
 */
export function farTargetMessage(symbol: string, target: number, last: number | null | undefined, coinNote: string | null, pence = false): string | null {
  if (last == null || !Number.isFinite(last) || last <= 0) return null;
  const above = target > last * MAX_TARGET_RATIO;
  if (!above && target >= last / MAX_TARGET_RATIO) return null;
  const how = above ? `more than ${MAX_TARGET_RATIO} times` : `under 1/${MAX_TARGET_RATIO} of`;
  // A London line quoted in pence says both in pence, the unit its quote shows (7,000p, 119.4p).
  const text = (value: number) => pence ? `${priceText(Number((value * 100).toPrecision(12)))}p` : priceText(value);
  return `A target of ${text(target)} is ${how} ${symbol}'s last price of ${text(last)}. ${coinNote ?? "Check the price and the symbol."}`;
}

export function alertCurrencyMismatch(typed: string | undefined, quoted: string | undefined, listing: string): string | null {
  const currency = quoted?.trim().toUpperCase();
  if (!typed || typed === currency) return null;
  return currency ? `${listing} is quoted in ${currency}, not ${typed}. Set the target in ${currency}.`
    : `Cannot verify the ${typed} target: the quote currency for ${listing} is unavailable.`;
}

export async function assertAlertCurrency(level: { price: number; currency?: string }, quote: Quote, listing: string,
  marketData: Pick<DataProvider, "getExchangeRate" | "getCachedQuery" | "revalidatesInBackground" | "getQuotesBatch">): Promise<void> {
  const mismatch = alertCurrencyMismatch(level.currency, quote.currency, listing);
  if (!mismatch) return;
  if (!quote.currency || !level.currency) throw new Error(mismatch);
  const convert = createBaseConverter(marketData, quote.currency);
  const amount = await convert(level.price, level.currency);
  const mark = convert.conversions()[0];
  if (!Number.isFinite(amount) || mark?.asOf == null) throw new Error(mismatch);
  const suggested = alertPriceWithCurrency({ symbol: quote.symbol, lastQuoteCurrency: quote.currency, lastQuotePence: isPenceQuotedLine(quote) }, amount);
  throw new Error(`${mismatch} About ${suggested} (${baseConversionLabel(mark)}).`);
}

/**
 * A level read in the unit its line's quote shows. On a London line quoted
 * in pence, `70p` is £0.70, and so is a bare 70 when 70 in pounds is ten
 * times off the price and 70p is not (VOD at 119.4p); the note says how it
 * was read. Pence on a line not quoted in them is refused, naming its unit.
 */
export function levelInQuoteUnit(
  level: { price: number; pence?: boolean; typed?: string; currency?: string },
  quote: Pick<Quote, "currency" | "providerPriceDivisor" | "price">,
  listing: string,
): { price: number; pence: boolean; note: string | null } {
  const mismatch = alertCurrencyMismatch(level.currency, quote.currency, listing);
  if (mismatch) throw new Error(mismatch);
  const pence = isPenceQuotedLine(quote);
  if (level.pence && !pence) {
    const currency = quote.currency?.trim().toUpperCase() || "";
    // A London line priced in pounds takes the level in pounds; anywhere else, pence mean nothing.
    if (currency !== "GBP") throw new Error(`${listing} trades in ${currency || "its own currency"}; pence (p) only apply to London prices.`);
    const typed = Number((level.price * 100).toPrecision(12));
    throw new Error(`${listing} is quoted in pounds (GBP), not pence: type ${typed / 100} for ${typed}p.`);
  }
  if (!pence || level.pence || level.currency) return { price: level.price, pence, note: null };
  const inPence = Number((level.price / 100).toPrecision(12));
  if (!farTargetMessage(listing, level.price, quote.price, null) || farTargetMessage(listing, inPence, quote.price, null)) return { price: level.price, pence, note: null };
  const typed = level.typed ?? String(level.price);
  return { price: inPence, pence, note: `Read ${typed} as ${typed}p: ${listing} is quoted in pence.` };
}
