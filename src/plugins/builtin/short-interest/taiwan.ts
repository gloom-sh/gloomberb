import type { TaiwanShortBalances, TaiwanVenue } from "../../../api-client/taiwan-short-balances";
import type { HeadlessPaneLoadArgs, HeadlessRowsResult } from "../../../types/headless";
import { canonicalExchange, parsePublicTickerKey } from "../../../utils/exchanges";
import { sfcValue } from "./sfc";

export function taiwanListing(key: string, exchange?: string): { symbol: string; exchange: TaiwanVenue } | null {
  const parsed = parsePublicTickerKey(key);
  const suffix = parsed.symbol.endsWith(".TWO") ? "TPEX" : parsed.symbol.endsWith(".TW") ? "TWSE" : null;
  const venue = parsed.exchange || canonicalExchange(exchange) || suffix;
  if ((venue !== "TWSE" && venue !== "TPEX") || (suffix && suffix !== venue)) return null;
  const symbol = parsed.symbol.replace(/\.TW(?:O)?$/, "");
  return /^[0-9][0-9A-Z]{3,11}$/.test(symbol) ? { symbol, exchange: venue } : null;
}

export const taiwanColumns = [
  { key: "day", header: "Trading date", width: 13 },
  { key: "marginBalance", header: "Margin short balance", width: 21, align: "right" },
  { key: "sblBalance", header: "SBL short balance", width: 19, align: "right" },
  { key: "marginSold", header: "Margin sold", width: 14, align: "right" },
  { key: "sblSold", header: "SBL sold", width: 14, align: "right" },
] as const;

export function taiwanEmpty(data: TaiwanShortBalances, asOf?: string) {
  if (!data.reportsReviewed) return asOf ? `No ${data.exchange} file observed by ${asOf}.` : `No ${data.exchange} reports available.`;
  return `No balance for ${data.symbol} in the ${data.reportsReviewed} exchange reports reviewed.`;
}

export function taiwanReport(data: TaiwanShortBalances, args: HeadlessPaneLoadArgs, asOf?: string): HeadlessRowsResult {
  const points = args.options.order === "oldest" ? [...data.points].reverse() : data.points;
  return {
    rows: points.slice(0, Number(args.options.limit)).map(row => ({ ...row })),
    columns: taiwanColumns.map(column => ({ ...column, format: sfcValue })),
    empty: taiwanEmpty(data, asOf), unit: "shares", interval: "daily",
    metadata: { symbol: args.symbols[0], source: data.exchange, reportsReviewed: data.reportsReviewed, newestReport: data.newestReport, ...(asOf ? { asOf } : {}) },
    notes: ["SBL counts short sales of borrowed securities. Balances are outstanding shares at the close. Sold is the trading day's volume."],
    freshness: { source: data.exchange, status: "not-a-feed", basis: "daily exchange short-sale balances", observedKey: "day", oldest: null },
  };
}
