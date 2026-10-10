import type { TickerRecord } from "../types/ticker";
import { tickerHasListingSuffix } from "../sources/listing-symbols";
import { canonicalExchange, parsePublicTickerKey, US_LISTING_EXCHANGES } from "./exchanges";

/** Canonical US equity venues: the listing exchanges plus other lit and OTC venues. */
const US_EQUITY_EXCHANGES = new Set([
  ...US_LISTING_EXCHANGES,
  "BYX",
  "IEX",
  "OTC",
  "PINK",
  // Listing codes for Cboe BZX and the OTC Markets tiers.
  "BTS",
  "PNK",
  "OQB",
  "OQX",
  "OEM",
  "OBB",
]);

/** Order-routing destinations, not listings. */
const ROUTING_EXCHANGES = new Set(["SMART"]);

function normalize(value?: string): string {
  return (value ?? "").trim().toUpperCase();
}

function isUsExchange(value?: string): boolean {
  return US_EQUITY_EXCHANGES.has(canonicalExchange(value));
}

function isEquityType(value?: string): boolean {
  const normalized = normalize(value).replace(/[\s_-]/g, "");
  return normalized.length === 0 || ["STK", "EQUITY", "ADR", "COMMONSTOCK", "DEPOSITARYRECEIPT"].includes(normalized);
}

const FUND_TYPES = new Set(["ETF", "ETP", "FUND", "MUTUALFUND", "CEF", "CLOSEDEND", "CLOSEDENDFUND"]);

function isFundType(value?: string): boolean {
  return FUND_TYPES.has(normalize(value).replace(/[\s_-]/g, ""));
}

/**
 * Whether an equity SEC pane (filings, insider transactions) can show the
 * ticker: an equity, or a type not filled in yet, that is not known to be
 * listed outside the US. A ticker whose venue and currency were never filled
 * in, as when its quote is unavailable, is looked up as a US ticker, as the
 * SEC issuer lookup does with a symbol that names no venue.
 */
export function mayBeUsEquityTicker(ticker: TickerRecord | null | undefined): boolean {
  return mayBeUsListingOfType(ticker, isEquityType);
}

/** The same for a view that also lists a US-listed fund's filings, which funds file with the SEC. */
export function mayBeUsEquityOrFundTicker(ticker: TickerRecord | null | undefined): boolean {
  return mayBeUsListingOfType(ticker, (type) => isEquityType(type) || isFundType(type));
}

function mayBeUsListingOfType(
  ticker: TickerRecord | null | undefined,
  acceptsType: (type?: string) => boolean,
): boolean {
  if (!ticker) return false;
  const primaryContract = ticker.metadata.broker_contracts?.[0];
  return acceptsType(primaryContract?.secType ?? ticker.metadata.assetCategory) && !isKnownNonUsListing(ticker);
}

/**
 * The metadata places the listing outside the US: a non-USD currency, venues
 * none of which is a US exchange, or, with no venue, a symbol that names one
 * abroad (SAN:EPA, VOD.L, 7203.T). A missing currency or venue is unknown
 * rather than foreign. SEC filings, FINRA short interest, 13F and
 * congressional disclosures only cover US listings.
 */
export function isKnownNonUsListing(ticker: TickerRecord | null | undefined): boolean {
  if (!ticker) return false;
  const primaryContract = ticker.metadata.broker_contracts?.[0];
  const currency = normalize(primaryContract?.currency ?? ticker.metadata.currency);
  if (currency && currency !== "USD") return true;
  const venues = [primaryContract?.primaryExchange, primaryContract?.exchange, ticker.metadata.exchange]
    .map(normalize)
    .filter((exchange) => exchange.length > 0 && !ROUTING_EXCHANGES.has(exchange));
  if (venues.length > 0) return !venues.some((exchange) => isUsExchange(exchange));
  const symbol = parsePublicTickerKey(ticker.metadata.ticker ?? "");
  if (symbol.exchange) return !ROUTING_EXCHANGES.has(symbol.exchange) && !isUsExchange(symbol.exchange);
  return tickerHasListingSuffix(symbol.symbol);
}

/**
 * The metadata shows the ticker is not a US equity: a non-equity type or a
 * listing known to be outside the US. A ticker with no venue or currency is
 * unknown rather than foreign, e.g. an unsaved symbol whose quote is
 * unavailable.
 */
export function isKnownNonUsEquityTicker(ticker: TickerRecord | null | undefined): boolean {
  return !!ticker && !mayBeUsEquityTicker(ticker);
}

/**
 * The venue an SEC issuer lookup has to respect: a listing outside the US,
 * whose bare symbol the SEC may know as another company (SAN is Banco
 * Santander in New York, Sanofi in Paris). Null for a US venue, a routing
 * destination or no venue at all, which look the symbol up as a US ticker.
 */
export function nonUsSecListingVenue(ticker: string, exchange?: string): string | null {
  const venue = parsePublicTickerKey(ticker).exchange ?? canonicalExchange(exchange);
  if (!venue || ROUTING_EXCHANGES.has(venue) || isUsExchange(venue)) return null;
  return venue;
}

/**
 * The key an issuer read is cached and deduplicated under: the ticker as given
 * for a US listing or a symbol with no venue, SYMBOL:VENUE for a listing
 * elsewhere, so SAN in Paris and SAN in New York never share an entry.
 */
export function secListingKey(ticker: string, exchange?: string): string {
  const venue = nonUsSecListingVenue(ticker, exchange);
  return venue ? `${parsePublicTickerKey(ticker).symbol}:${venue}` : normalize(ticker);
}

/**
 * The item codes in EDGAR's `items` field ("2.02,9.01"). EDGAR fills the same
 * field with other values for some forms, such as the order dates of a CT
 * ORDER ("20250123,20250123"); those are not items and are dropped.
 */
export function secFilingItemCodes(items: string | null | undefined): string | null {
  const codes = (items ?? "")
    .split(",")
    .map((code) => code.trim())
    .filter((code) => /^\d{1,2}\.\d{2}$/.test(code));
  return codes.length > 0 ? codes.join(",") : null;
}
