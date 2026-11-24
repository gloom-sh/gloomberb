import type { SfcShortPositions } from "../../../api-client/sfc-short-positions";
import type { HeadlessPaneColumn, HeadlessPaneLoadArgs, HeadlessRowsResult } from "../../../types/headless";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { MISSING_VALUE } from "../../../utils/format";
import { nonUsSecListingVenue } from "../../../utils/sec";

export function sfcSymbol(key: string, exchange?: string): string | null {
  const {symbol} = parsePublicTickerKey(key);
  const venue = nonUsSecListingVenue(key, exchange);
  if (venue !== "HKEX" && (venue || !/\.HK$/i.test(symbol))) return null;
  const code = symbol.replace(/\.HK$/i, "");
  return /^\d{1,5}$/.test(code) && Number(code) > 0 ? String(Number(code)).padStart(4, "0") : null;
}

export const sfcColumns = [
  { key: "day", header: "Reporting date", width: 14 },
  { key: "shares", header: "Reportable shares", width: 18, align: "right" },
  { key: "valueHkd", header: "Value (HKD)", width: 17, align: "right" },
] as const;

export function sfcValue(value: unknown): string {
  return typeof value === "number" ? value.toLocaleString("en-US") : String(value ?? MISSING_VALUE);
}

export function sfcEmpty(data: SfcShortPositions, asOf?: string) {
  if (!data.reportsReviewed) return asOf ? `No SFC file was observed by ${asOf}.` : "No weekly SFC files available.";
  return `No reported position for ${data.symbol} in the ${data.reportsReviewed} weekly SFC files reviewed.`;
}

export function sfcReport(data: SfcShortPositions, args: HeadlessPaneLoadArgs, asOf?: string): HeadlessRowsResult {
  const ordered = args.options.order === "oldest" ? [...data.points].reverse() : data.points;
  const columns: HeadlessPaneColumn[] = sfcColumns.map(column => ({ ...column, format: sfcValue }));
  return {
    rows: ordered.slice(0, Number(args.options.limit)).map(row => ({ ...row })), columns,
    notes: ["Weekly net short positions meeting the SFC reporting thresholds.", ...(asOf ? ["Cutoff uses files observed by the end of the Hong Kong day."] : [])],
    empty: sfcEmpty(data, asOf),
    metadata: { symbol: args.symbols[0], source: data.source, page: data.page, reportsReviewed: data.reportsReviewed, newestReport: data.newestReport, ...(asOf ? { asOf } : {}) },
    freshness: { source: data.source, status: "not-a-feed", basis: "weekly reportable positions", observedKey: "day", oldest: null },
  };
}
