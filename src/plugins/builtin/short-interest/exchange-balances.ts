import type { apiClient } from "../../../api-client";
import type { BalanceVenue, KoreanShortPositions, MainlandLendingBalances, TaiwanShortBalances } from "../../../api-client/exchange-short-balances";
import type { HeadlessPaneLoadArgs, HeadlessRowsResult } from "../../../types/headless";
import { canonicalExchange, parsePublicTickerKey } from "../../../utils/exchanges";
import { sfcValue } from "./sfc";

const suffixes: Record<string, BalanceVenue> = { TWO: "TPEX", TW: "TWSE", SS: "SSE", SZ: "SZSE", KS: "KRX", KQ: "KOSDAQ" };

export function balanceListing(key: string, exchange?: string): { symbol: string; exchange: BalanceVenue } | null {
  const parsed = parsePublicTickerKey(key);
  const suffix = suffixes[parsed.symbol.split(".")[1] ?? ""];

  const venue = parsed.exchange || canonicalExchange(exchange) || suffix;
  if (suffix && suffix !== venue) return null;
  const symbol = parsed.symbol.replace(/\.(?:TW(?:O)?|SS|SZ|KS|KQ)$/, "");
  if (venue === "KRX" || venue === "KOSDAQ") return /^[0-9][0-9A-Z]{5}$/.test(symbol) ? { symbol, exchange: venue } : null;
  if (venue === "SSE" || venue === "SZSE") return /^\d{6}$/.test(symbol) ? { symbol, exchange: venue } : null;
  if (venue !== "TWSE" && venue !== "TPEX") return null;
  return /^[0-9][0-9A-Z]{3,11}$/.test(symbol) ? { symbol, exchange: venue } : null;
}

const taiwanColumns = [
  { key: "day", header: "Trading date", width: 13 },
  { key: "marginBalance", header: "Margin short balance", width: 21, align: "right" },
  { key: "sblBalance", header: "SBL short balance", width: 19, align: "right" },
  { key: "marginSold", header: "Margin sold", width: 14, align: "right" },
  { key: "sblSold", header: "SBL sold", width: 14, align: "right" },
] as const;

const mainlandColumns = [
  { key: "day", header: "Trading date", width: 13 },
  { key: "outstanding", header: "Outstanding on loan", width: 21, align: "right" },
  { key: "sold", header: "Sold short", width: 16, align: "right" },
] as const;

const koreanColumns = [
  { key: "day", header: "Position date", width: 13 },
  { key: "netShort", header: "Net short shares", width: 18, align: "right" },
  { key: "percent", header: "% of listed shares", width: 19, align: "right" },
  { key: "valueKrw", header: "Value (KRW)", width: 20, align: "right" },
  { key: "listedShares", header: "Listed shares", width: 18, align: "right" },
] as const;

export function balanceColumns(venue: BalanceVenue) {
  if (venue === "KRX" || venue === "KOSDAQ") return koreanColumns;
  return venue === "SSE" || venue === "SZSE" ? mainlandColumns : taiwanColumns;
}

export function readExchangeBalances(client: Pick<typeof apiClient, "getKoreanShortPositions" | "getMainlandLendingBalances" | "getTaiwanShortBalances">, symbol: string, venue: BalanceVenue, asOf?: string) {
  if (venue === "KRX" || venue === "KOSDAQ") return client.getKoreanShortPositions(symbol, venue, asOf);
  return venue === "SSE" || venue === "SZSE"
    ? client.getMainlandLendingBalances(symbol, venue, asOf)
    : client.getTaiwanShortBalances(symbol, venue, asOf);
}

type Report = TaiwanShortBalances | MainlandLendingBalances | KoreanShortPositions;
export function balanceEmpty(data: Report, asOf?: string) {
  if (!data.reportsReviewed) return asOf ? `No ${data.exchange} file observed by ${asOf}.` : `No ${data.exchange} reports available.`;
  return `No balance for ${data.symbol} in the ${data.reportsReviewed} exchange reports reviewed.`;
}

export function balanceReport(data: Report, args: HeadlessPaneLoadArgs, asOf?: string): HeadlessRowsResult {
  const points = args.options.order === "oldest" ? [...data.points].reverse() : data.points;
  const korean = data.exchange === "KRX" || data.exchange === "KOSDAQ";
  const source = korean ? "Korea Exchange" : data.exchange;
  return {
    rows: points.slice(0, Number(args.options.limit)).map(row => ({ ...row })),
    columns: balanceColumns(data.exchange).map(column => ({ ...column, format: sfcValue })),
    empty: balanceEmpty(data, asOf), ...(!korean ? {unit: "shares"} : {}), interval: "daily",
    metadata: { symbol: args.symbols[0], source, reportsReviewed: data.reportsReviewed, newestReport: data.newestReport, ...(asOf ? { asOf } : {}) },
    notes: korean ? ["KRX aggregates disclosed net short positions by security. The percentage uses listed shares. Reports become available after the position date."] : data.exchange === "SSE" || data.exchange === "SZSE"
      ? ["Outstanding on loan is the closing securities lending balance. Sold short is the trading day’s volume in shares or fund units."]
      : ["SBL counts short sales of borrowed securities. Balances are outstanding shares at the close. Sold is the trading day's volume."],
    freshness: { source, status: "not-a-feed", basis: "daily exchange short-sale balances", observedKey: "day", oldest: null },
  };
}
