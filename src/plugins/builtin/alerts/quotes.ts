import type { DataProvider } from "../../../types/data-provider";
import type { Quote } from "../../../types/financials";
import { getActiveQuoteDisplay } from "../../../market-data/market/status";
import { isQuoteStaleForCurrentSession } from "../../../market-data/quotes/freshness";
import { canonicalExchange } from "../../../utils/exchanges";
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
  const quote = await marketData.getQuote(symbol, exchange);
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
    lastCheckError: undefined,
  };
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
export function farTargetMessage(symbol: string, target: number, last: number | null | undefined, coinNote: string | null): string | null {
  if (last == null || !Number.isFinite(last) || last <= 0) return null;
  const above = target > last * MAX_TARGET_RATIO;
  if (!above && target >= last / MAX_TARGET_RATIO) return null;
  const how = above ? `more than ${MAX_TARGET_RATIO} times` : `under 1/${MAX_TARGET_RATIO} of`;
  return `A target of ${priceText(target)} is ${how} ${symbol}'s last price of ${priceText(last)}. ${coinNote ?? "Check the price and the symbol."}`;
}
