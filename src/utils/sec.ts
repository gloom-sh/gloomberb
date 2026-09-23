import type { TickerRecord } from "../types/ticker";
import { canonicalExchange } from "./exchanges";

const US_EQUITY_EXCHANGES = new Set([
  "AMEX",
  "ARCA",
  "BATS",
  "BYX",
  "IEX",
  "NASDAQ",
  "NMS",
  "NYSE",
  "NYSEARCA",
  "OTC",
  "PINK",
]);

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

export function isUsEquityTicker(ticker: TickerRecord | null | undefined): boolean {
  if (!ticker) return false;

  const primaryContract = ticker.metadata.broker_contracts?.[0];
  const type = primaryContract?.secType ?? ticker.metadata.assetCategory;
  const currency = normalize(primaryContract?.currency ?? ticker.metadata.currency);
  const exchangeCandidates = [
    primaryContract?.primaryExchange,
    primaryContract?.exchange,
    ticker.metadata.exchange,
  ];

  return isEquityType(type)
    && currency === "USD"
    && exchangeCandidates.some((exchange) => isUsExchange(exchange));
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
