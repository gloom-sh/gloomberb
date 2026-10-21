import type { TickerRecord } from "../types/ticker";
import { tickerHasListingSuffix } from "../sources/listing-symbols";
import { canonicalExchange, exchangeLabel, parsePublicTickerKey, resolveExchangeTimeZone, US_LISTING_EXCHANGES } from "./exchanges";
import { shortListingTitle } from "../tickers/company-name";

/** Canonical US equity venues: the listing exchanges plus other lit and OTC venues. */
const US_EQUITY_EXCHANGES = new Set([
  ...US_LISTING_EXCHANGES,
  "BYX",
  "IEX",
  "OTC",
  "PINK",
  // Listing codes for the OTC Markets tiers.
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
  return normalized.length === 0
    || ["STK", "EQUITY", "ADR", "AMERICANDEPOSITARYRECEIPT", "COMMONSTOCK", "DEPOSITARYRECEIPT"].includes(normalized);
}

const FUND_TYPES = new Set(["ETF", "ETP", "FUND", "MUTUALFUND", "CEF", "CLOSEDEND", "CLOSEDENDFUND"]);

/** An instrument type that names a fund (ETF, closed-end fund), which reports no earnings of its own. */
export function isFundType(value?: string): boolean {
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

/**
 * `mayBeUsEquityTicker`, or an equity listed abroad on a venue its metadata
 * names. The SEC lookup takes such a listing by its company, which either
 * files there (Sanofi, a foreign private issuer) or files nothing
 * (`noSecReportsNotice`); without the venue it cannot place the listing.
 */
export function mayBeSecEquityListing(ticker: TickerRecord | null | undefined): boolean {
  if (mayBeUsEquityTicker(ticker)) return true;
  return isTickerOfType(ticker, isEquityType) && nonUsSecListingVenue(ticker!.metadata.ticker, ticker!.metadata.exchange) != null;
}

/** The same for a view that also lists a US-listed fund's filings, which funds file with the SEC. */
export function mayBeUsEquityOrFundTicker(ticker: TickerRecord | null | undefined): boolean {
  return mayBeUsListingOfType(ticker, (type) => isEquityType(type) || isFundType(type));
}

function isTickerOfType(ticker: TickerRecord | null | undefined, acceptsType: (type?: string) => boolean): boolean {
  if (!ticker) return false;
  const primaryContract = ticker.metadata.broker_contracts?.[0];
  return acceptsType(primaryContract?.secType ?? ticker.metadata.assetCategory);
}

function mayBeUsListingOfType(
  ticker: TickerRecord | null | undefined,
  acceptsType: (type?: string) => boolean,
): boolean {
  return isTickerOfType(ticker, acceptsType) && !isKnownNonUsListing(ticker);
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

// The zones of the US exchanges; a venue in another is abroad.
const US_TIME_ZONES = new Set(["America/New_York", "America/Chicago"]);

/**
 * The exchange abroad a listing key names, for data that covers US listings
 * only (US options and trades, FINRA short interest, the US earnings board):
 * EPA for SAN:EPA, JPX for 7203:JPX. Null for a US exchange, no exchange, and
 * venues with no home market (futures, currency and crypto venues), which
 * such data reads by symbol.
 */
export function listingAbroadVenue(key: string): string | null {
  const venue = nonUsSecListingVenue(key);
  const zone = venue ? resolveExchangeTimeZone(venue) : null;
  return venue && zone && zone !== "UTC" && !US_TIME_ZONES.has(zone) ? venue : null;
}

/**
 * The symbol data that covers US listings only reads a listing by: AAPL for
 * AAPL:NASDAQ, ^SPX as it is. A listing abroad throws, naming what covers US
 * listings only, rather than read its bare symbol, which can be another
 * company's US ticker (SAN:EPA is Sanofi, SAN in New York Banco Santander).
 */
export function usListingSymbol(key: string, what: string): string {
  const parsed = parsePublicTickerKey(key.trim());
  const venue = listingAbroadVenue(key);
  if (venue) throw new Error(`${what} covers US listings only, and ${parsed.symbol}:${venue} is listed on ${exchangeLabel(venue)}.`);
  return parsed.symbol.toUpperCase();
}

/**
 * "CAR Group (ASX) files no SEC reports.": what the SEC functions (filings,
 * holders --form, insider and INS, in the CLI and the pane) say for a listing
 * abroad whose company the SEC has nothing from.
 */
export function noSecReportsNotice(listing: { symbol: string; exchange: string; name: string | null }): string {
  return `${shortListingTitle(listing)} files no SEC reports.`;
}

/** The country of a venue abroad, ISO 3166 alpha-2, for the companies an SEC report may list there. */
const VENUE_COUNTRY: Readonly<Record<string, string>> = {
  TSX: "CA", TSXV: "CA", CSE: "CA", NEO: "CA",
  LSE: "GB",
  ASX: "AU", CXA: "AU", NZX: "NZ",
  SWX: "CH",
  XETRA: "DE", FWB2: "DE", EPA: "FR", AMS: "NL", BRU: "BE", LIS: "PT", BIT: "IT", MCE: "ES", ISE: "IE",
  SFB: "SE", HEL: "FI", CPH: "DK", OSL: "NO", ICEX: "IS", WSE: "PL", PSE: "CZ", VIE: "AT", WBDM: "AT",
  JPX: "JP", HKEX: "HK", KRX: "KR", KOSDAQ: "KR", TWSE: "TW", TPEX: "TW", SSE: "CN", SZSE: "CN",
  NSE: "IN", BSE: "IN", SGX: "SG", SET: "TH",
  BMV: "MX", B3: "BR", BYMA: "AR", JSE: "ZA", TASE: "IL", BIST: "TR", TADAWUL: "SA",
};

/** The European Economic Area, whose issuers report managers' dealings under the Market Abuse Regulation. */
const EEA = new Set(["AT", "BE", "CZ", "DE", "DK", "ES", "FI", "FR", "IE", "IS", "IT", "NL", "NO", "PL", "PT", "SE"]);

/** Insider reports outside the SEC by the name they go by, by the issuer's country. */
const HOME_INSIDER_REPORTS: Readonly<Record<string, string>> = {
  CA: "Canadian insider reports (SEDI)",
  GB: "UK insider reports (PDMR notifications)",
  AU: "Australian insider reports (Appendix 3Y)",
};

/** A country's English name ("Japan"), or null when the runtime has none. */
function countryName(code: string): string | null {
  try {
    const name = new Intl.DisplayNames(["en"], { type: "region" }).of(code);
    return name && name !== code ? name : null;
  } catch {
    // Intentional ignore: a runtime without region names leaves the home market unnamed.
    return null;
  }
}

/**
 * What a company from abroad's insiders report at home, which Form 4 data
 * does not cover: "Canadian insider reports (SEDI) not covered." Where home
 * is comes from the company's country (Gloom Cloud's issuer listings: RY in
 * New York is Royal Bank of Canada), else its listing's venue abroad (RY:TSX).
 * A foreign private issuer placed by neither gets its home market unnamed.
 * Null for a US company, and for a US listing of a company that files as a
 * domestic one, whose insiders file Form 4.
 */
export function homeInsiderReportsNote({ country, exchange, foreignPrivateIssuer = false }: {
  /** The company's country, ISO 3166 alpha-2, when known. */
  country?: string | null;
  /** The listing's venue. */
  exchange?: string | null;
  foreignPrivateIssuer?: boolean;
}): string | null {
  const venueHome = VENUE_COUNTRY[canonicalExchange(exchange ?? "")] ?? "";
  if (!venueHome && !foreignPrivateIssuer) return null;
  // ZZ is the service's own word for a country it does not know.
  const given = normalize(country ?? "");
  const home = (given !== "ZZ" ? given : "") || venueHome;
  if (home === "US") return null;
  if (!home) return foreignPrivateIssuer ? "Home-market insider reports not covered." : null;
  const named = HOME_INSIDER_REPORTS[home] ?? (EEA.has(home) ? "European insider reports (MAR managers' transactions)" : null);
  if (named) return `${named} not covered.`;
  const place = countryName(home);
  return place ? `Insider reports filed in ${place} not covered.` : "Home-market insider reports not covered.";
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
