import type { Quote } from "../../types/financials";
import { isYieldIndexSymbol } from "../../tickers/index-roots";
import { currencyPairCode } from "../../utils/currency-pair";
import { parsePublicTickerKey } from "../../utils/exchanges";
import { INDEX_POINTS_EXPORT_UNIT, isIndexLevel, YIELD_INDEX_EXPORT_UNIT } from "../market/index-level";
import { delayedFeedLagMs } from "../market/freshness";
import { quoteHeadlineTime, quoteSessionStateLabel } from "../market/status";
import { isQuoteStaleForCurrentSession } from "./freshness";

/** The quotes Gloom Cloud serves, which an export cites by that name. */
const CLOUD_PROVIDER_ID = "gloomberb-cloud";
const CLOUD_SOURCE = "Gloom Cloud";

/**
 * The columns a pane's quote export ends each row with, as `quote --csv` does:
 * the session and feed its figures are from, why a figure is missing, then
 * what the row is (its listing with the venue, the unit its prices are in),
 * where it comes from and when its price was observed.
 */
export const QUOTE_EXPORT_IDENTITY_HEADERS = [
  "Session", "Feed", "status", "symbol_or_series", "currency_or_unit", "interval", "source", "as_of",
] as const;

/**
 * The unit a quote's price is in, as `quote --csv` names it: index points for
 * an index level, pct for a Cboe yield index, a pair's quote currency per base
 * (JPY per USD), else its currency.
 */
export function quoteExportUnit(symbol: string, quote: Pick<Quote, "currency" | "instrumentType"> | null | undefined): string | null {
  const bare = parsePublicTickerKey(symbol).symbol;
  if (isYieldIndexSymbol(bare)) return YIELD_INDEX_EXPORT_UNIT;
  if (isIndexLevel(quote?.instrumentType)) return INDEX_POINTS_EXPORT_UNIT;
  const currency = quote?.currency?.trim() || null;
  const pair = currencyPairCode(bare.toUpperCase());
  if (pair && currency === pair.slice(3)) return `${pair.slice(3)} per ${pair.slice(0, 3)}`;
  return currency;
}

/** A broker's name by the id its quotes carry (`ibkr`: Interactive Brokers); null for no broker of that id. */
export type BrokerNameOf = (providerId: string) => string | null | undefined;

/**
 * Where a quote is from, as an export's `source` names it: Gloom Cloud, or
 * the broker whose feed it is, by its name. Blank for a source with no name
 * to give, never its internal id.
 */
export function quoteSourceName(quote: Pick<Quote, "providerId" | "priceVenue"> | null | undefined, brokerName?: BrokerNameOf): string {
  if (!quote) return "";
  // A coin priced by one exchange's own trade is that exchange's price, not the composite's.
  if (quote.priceVenue && (!quote.providerId || quote.providerId === CLOUD_PROVIDER_ID)) return quote.priceVenue;
  if (!quote.providerId || quote.providerId === CLOUD_PROVIDER_ID) return CLOUD_SOURCE;
  return brokerName?.(quote.providerId)?.trim() || "";
}

/**
 * What a coin's day range and volume measure, as said beside them: `composite` (across exchanges), `composite +
 * Coinbase` when the range was widened to take in the exchange's price, or `1 exchange` (one exchange's own day).
 * Empty when the service does not say, as for anything but a coin.
 */
export function quoteStatsBasisText(quote: Pick<Quote, "statsBasis" | "rangeWidened" | "priceVenue"> | null | undefined, range = true): string {
  if (quote?.statsBasis === "exchange") return "1 exchange";
  if (quote?.statsBasis !== "composite") return "";
  return range && quote.rangeWidened && quote.priceVenue ? `composite + ${quote.priceVenue}` : "composite";
}

const UTC_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Where a coin's price is from and when, as its header says it: the exchange whose own trade it is and that trade's
 * time (`Coinbase · 21:53:40 UTC`), the composite of several exchanges and its time, or `composite · 15m delayed`
 * when it is held back. A time from another UTC day leads with its weekday. Empty for a quote Gloom Cloud does not
 * price, such as a broker's.
 */
export function coinPriceVenueText(
  quote: Pick<Quote, "providerId" | "priceVenue" | "dataSource" | "lastUpdated"> | null | undefined,
  now = Date.now(),
): string {
  if (!quote || (quote.providerId && quote.providerId !== CLOUD_PROVIDER_ID)) return "";
  const venue = quote.priceVenue ?? "composite";
  if (!quote.priceVenue && quote.dataSource === "delayed") return `${venue} · ${delayedFeedLagMs("CCC") / 60_000}m delayed`;
  if (!Number.isFinite(quote.lastUpdated) || quote.lastUpdated <= 0) return venue;
  const at = new Date(quote.lastUpdated);
  const day = Math.floor(quote.lastUpdated / 86_400_000) === Math.floor(now / 86_400_000) ? "" : `${UTC_WEEKDAYS[at.getUTCDay()]} `;
  return `${venue} · ${day}${at.toISOString().slice(11, 19)} UTC`;
}

/** Whether a quote's feed is live, delayed or stale, as the Feed cell of `quote` says it. */
export function quoteExportFeed(quote: Quote | null | undefined, now = Date.now()): string {
  if (!quote) return "";
  if (isQuoteStaleForCurrentSession(quote, now)) return "stale";
  return quote.dataSource === "live" || quote.dataSource === "delayed" ? quote.dataSource : "";
}

/**
 * The cells `QUOTE_EXPORT_IDENTITY_HEADERS` name for one row: `listing` is the
 * row's listing with its venue (BA:LSE), the as-of the ISO instant its Last
 * was observed (each row its own: Hong Kong's close beside New York's).
 */
export function quoteExportIdentityCells(listing: string, quote: Quote | null | undefined, now = Date.now(), brokerName?: BrokerNameOf): string[] {
  const asOf = quote?.lastUpdated ? new Date(quoteHeadlineTime(quote)).toISOString() : "";
  return [
    quote ? quoteSessionStateLabel(quote, now) ?? "" : "",
    quoteExportFeed(quote, now),
    quote ? "" : "Last: no quote",
    listing,
    quoteExportUnit(listing, quote) ?? "",
    "",
    quoteSourceName(quote, brokerName),
    asOf,
  ];
}
