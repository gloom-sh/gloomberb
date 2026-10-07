import type { TickerRecord } from "../types/ticker";
import { canonicalExchange, US_LISTING_EXCHANGES } from "./exchanges";

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

export function isUsEquityTicker(ticker: TickerRecord | null | undefined): boolean {
  return isUsListingOfType(ticker, isEquityType);
}

/** A US equity, or a US-listed fund, which files fund forms with the SEC. */
export function isUsEquityOrFundTicker(ticker: TickerRecord | null | undefined): boolean {
  return isUsListingOfType(ticker, (type) => isEquityType(type) || isFundType(type));
}

function isUsListingOfType(
  ticker: TickerRecord | null | undefined,
  acceptsType: (type?: string) => boolean,
): boolean {
  if (!ticker) return false;

  const primaryContract = ticker.metadata.broker_contracts?.[0];
  const type = primaryContract?.secType ?? ticker.metadata.assetCategory;
  const currency = normalize(primaryContract?.currency ?? ticker.metadata.currency);
  const exchangeCandidates = [
    primaryContract?.primaryExchange,
    primaryContract?.exchange,
    ticker.metadata.exchange,
  ];

  // A listing saved without a known currency counts by its venue.
  return acceptsType(type)
    && (currency === "USD" || !currency)
    && exchangeCandidates.some((exchange) => isUsExchange(exchange));
}

/**
 * The metadata places the listing outside the US: a non-USD currency, or
 * venues none of which is a US exchange. A missing currency or venue is
 * unknown rather than foreign. SEC filings, FINRA short interest, 13F and
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
  return venues.length > 0 && !venues.some((exchange) => isUsExchange(exchange));
}

/**
 * The metadata shows the ticker is not a US equity: a non-USD currency, a
 * non-equity type, or only non-US exchanges. A USD ticker with no exchange is
 * unknown rather than foreign, e.g. an unsaved symbol from a quote without a
 * listing exchange.
 */
export function isKnownNonUsEquityTicker(ticker: TickerRecord | null | undefined): boolean {
  if (!ticker || isUsEquityTicker(ticker)) return false;
  const primaryContract = ticker.metadata.broker_contracts?.[0];
  const currency = normalize(primaryContract?.currency ?? ticker.metadata.currency);
  if (currency && currency !== "USD") return true;
  if (!isEquityType(primaryContract?.secType ?? ticker.metadata.assetCategory)) return true;
  return [primaryContract?.primaryExchange, primaryContract?.exchange, ticker.metadata.exchange]
    .some((exchange) => normalize(exchange).length > 0);
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
