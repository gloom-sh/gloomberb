import type { JpxShortPositions } from "../../../api-client/jpx-short-positions";
import type { HeadlessPaneLoadArgs, HeadlessRowsResult } from "../../../types/headless";
import { canonicalExchange, parsePublicTickerKey } from "../../../utils/exchanges";
import { sfcValue } from "./sfc";

export function jpxSymbol(input: string, exchange?: string) {
  const parsed = parsePublicTickerKey(input);
  const venue = parsed.exchange || canonicalExchange(exchange);
  if (venue ? venue !== "JPX" : !parsed.symbol.endsWith(".T")) return null;
  const code = parsed.symbol.replace(/\.T$/, "");
  return /^[0-9][0-9A-Z]{3}$/.test(code) ? code : null;
}

export const jpxColumns = [
  { key: "day", header: "Disclosed", width: 12 },
  { key: "calculated", header: "Position date", width: 14 },
  { key: "seller", header: "Short seller", width: 30 },
  { key: "shares", header: "Shares", width: 15, align: "right" },
  { key: "percent", header: "% outstanding", width: 15, align: "right" },
  { key: "fund", header: "Fund", width: 24 },
] as const;

export function jpxEmpty(data: JpxShortPositions, asOf?: string) {
  if (!data.reportsReviewed) return asOf ? `No JPX disclosure file observed by ${asOf}.` : "No JPX disclosure files available.";
  return `No short seller disclosed a position for ${data.symbol} in the ${data.reportsReviewed} JPX files reviewed.`;
}

export function jpxReport(data: JpxShortPositions, args: HeadlessPaneLoadArgs, asOf?: string): HeadlessRowsResult {
  const rows = args.options.order === "oldest" ? [...data.points].sort((a,b) => a.day.localeCompare(b.day) || a.line - b.line) : data.points;
  return {
    rows: rows.slice(0, Number(args.options.limit)).map(row => ({ ...row })),
    columns: jpxColumns.map(column => ({ ...column, format: sfcValue })),
    empty: jpxEmpty(data, asOf), interval: "daily",
    metadata: { symbol: args.symbols[0], source: data.source, page: data.page, reportsReviewed: data.reportsReviewed, newestReport: data.newestReport, ...(asOf ? { asOf } : {}) },
    notes: ["Each row is a seller disclosure. JPX publishes positions reaching 0.5% of shares outstanding and subsequent reports falling below the threshold."],
    freshness: { source: data.source, status: "not-a-feed", basis: "dated short seller disclosures", observedKey: "day", oldest: null },
  };
}
