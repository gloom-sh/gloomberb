import type { DataProvider } from "../../../types/data-provider";
import { chunked } from "../../../utils/concurrency";
import type { Quote } from "../../../types/financials";
import { getActiveQuoteDisplay } from "../../../market-data/market/status";
import { isPenceQuotedLine } from "../../../market-data/market/format";
import { isQuoteStaleForCurrentSession } from "../../../market-data/quotes/freshness";
import { canonicalExchange } from "../../../utils/exchanges";
import { readMove } from "./move";
import type { AlertRule } from "./types";

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
function alertQuote(quote: Quote, symbol: string): Quote {
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
> & { lastCheckError?: undefined } {
  const exchange = quote.listingExchangeName || quote.exchangeName;
  return {
    lastCheckedPrice: quote.price,
    lastCheckedAt: checkedAt,
    lastQuoteUpdatedAt: quote.lastUpdated,
    lastQuoteSource: quote.dataSource,
    lastQuoteProviderId: quote.providerId,
    ...(quote.currency ? { lastQuoteCurrency: quote.currency } : {}),
    ...(exchange ? { lastQuoteExchange: canonicalExchange(exchange) } : {}),
    // A London line in pence writes its levels in pence; a quote that is not clears it.
    lastQuotePence: isPenceQuotedLine(quote) || undefined,
    lastCheckError: undefined,
  };
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

/**
 * A level read in the unit its line's quote shows. On a London line quoted
 * in pence, `70p` is £0.70, and so is a bare 70 when 70 in pounds is ten
 * times off the price and 70p is not (VOD at 119.4p); the note says how it
 * was read. Pence on a line not quoted in them is refused, naming its unit.
 */
export function levelInQuoteUnit(
  level: { price: number; pence?: boolean; typed?: string },
  quote: Pick<Quote, "currency" | "providerPriceDivisor" | "price">,
  listing: string,
): { price: number; pence: boolean; note: string | null } {
  const pence = isPenceQuotedLine(quote);
  if (level.pence && !pence) {
    const currency = quote.currency?.trim().toUpperCase() || "";
    // A London line priced in pounds takes the level in pounds; anywhere else, pence mean nothing.
    if (currency !== "GBP") throw new Error(`${listing} trades in ${currency || "its own currency"}; pence (p) only apply to London prices.`);
    const typed = Number((level.price * 100).toPrecision(12));
    throw new Error(`${listing} is quoted in pounds (GBP), not pence: type ${typed / 100} for ${typed}p.`);
  }
  if (!pence || level.pence) return { price: level.price, pence, note: null };
  const inPence = Number((level.price / 100).toPrecision(12));
  if (!farTargetMessage(listing, level.price, quote.price, null) || farTargetMessage(listing, inPence, quote.price, null)) return { price: level.price, pence, note: null };
  const typed = level.typed ?? String(level.price);
  return { price: inPence, pence, note: `Read ${typed} as ${typed}p: ${listing} is quoted in pence.` };
}
