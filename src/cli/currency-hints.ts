import { isVenueAbroad } from "../tickers/listing-fate";
import type { Quote } from "../types/financials";
import { isCurrencyCode } from "../utils/currency-pair";
import { canonicalExchange } from "../utils/exchanges";
import { UNLISTED_TYPES, type CliListing } from "./listing-arg";

// Quoted as dollars per unit (EUR/USD); every other currency as units per dollar (USD/MXN).
const DOLLARS_PER_UNIT = new Set(["EUR", "GBP", "AUD", "NZD"]);

/**
 * "MXN is also a currency: fx MXN, quote USD/MXN" for a bare currency code
 * that read as a listing abroad (MXN is mixi Inc on Stuttgart's exchange): the
 * quote is that company's, and a currency was likely what was typed. Null for
 * a code that is no currency, for the dollar (a US fund trades as USD, and
 * there is no USD/USD), for a listing that named or saved its venue, and for
 * one in the US.
 */
export function currencyCodeNote(
  listing: Pick<CliListing, "symbol" | "exchange" | "saved">,
  quote: Pick<Quote, "listingExchangeName" | "exchangeName" | "instrumentType"> | null | undefined,
): string | null {
  const code = listing.symbol;
  if (!quote || listing.exchange || listing.saved || code === "USD" || !/^[A-Z]{3}$/.test(code) || !isCurrencyCode(code)) return null;
  if (UNLISTED_TYPES.has(quote.instrumentType?.trim().toUpperCase() ?? "")) return null;
  if (!isVenueAbroad(canonicalExchange(quote.listingExchangeName || quote.exchangeName))) return null;
  return `${code} is also a currency: fx ${code}, quote ${DOLLARS_PER_UNIT.has(code) ? `${code}/USD` : `USD/${code}`}`;
}
