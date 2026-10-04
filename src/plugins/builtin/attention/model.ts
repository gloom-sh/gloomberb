import type { AttentionPayload, AttentionPoint, AttentionRow, AttentionWindow } from "../../../api-client/attention";
import type { DataTableColumn } from "../../../components";
export const ATTENTION_TABS = [{ value: "ranking", label: "Ranking" }, { value: "abnormal", label: "Abnormal" },
  { value: "sectors", label: "Sectors" }, { value: "countries", label: "Countries" }, { value: "history", label: "History" }, { value: "evidence", label: "Evidence" }] as const;
export type AttentionTab = typeof ATTENTION_TABS[number]["value"];
export const attentionTab = (value: unknown): AttentionTab => ATTENTION_TABS.find((tab) => tab.value === value)?.value ?? "ranking";
export const attentionWindow = (value: unknown): AttentionWindow => value === "today" || value === "week" ? value : "now";
export const WINDOWS = [{ value: "now", label: "Now" }, { value: "today", label: "Today" }, { value: "week", label: "Week" }];
export const number = (value: number | null | undefined, digits = 0) => value == null ? "--" : value.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
export const signed = (value: number | null | undefined, suffix = "") => value == null ? "--" : `${value > 0 ? "+" : ""}${number(value, 2)}${suffix}`;
export const date = (value: string | null | undefined) => value ? value.slice(0, 16).replace("T", " ") + " UTC" : "--";
/** A time in a column whose header already says UTC. */
export const hour = (value: string) => value.slice(0, 16).replace("T", " ");
export const COLUMNS: DataTableColumn[] = [
  { id: "rank", label: "Rank", width: 5, align: "right" }, { id: "symbol", label: "Ticker", width: 15, align: "left" },
  { id: "name", label: "Name", width: 23, flexGrow: 1, align: "left" }, { id: "researchUnits", label: "Research hrs", width: 12, align: "right" },
  { id: "sharePct", label: "Share %", width: 16, align: "right" }, { id: "zScore", label: "1H Z-score", width: 10, align: "right" },
  { id: "priceChangePct", label: "Price %", width: 9, align: "right" }, { id: "relativeVolume", label: "Rel vol", width: 8, align: "right" },
  { id: "sector", label: "Sector", width: 20, align: "left" }, { id: "country", label: "Country", width: 9, align: "left" },
];
export const GROUP_COLUMNS: DataTableColumn[] = [{ id: "name", label: "Group", width: 25, flexGrow: 1, align: "left" },
  { id: "researchUnits", label: "Research hrs", width: 13, align: "right" }, { id: "sharePct", label: "Share %", width: 30, align: "right" },
  { id: "tickers", label: "Tickers", width: 9, align: "right" }];
export const HISTORY_COLUMNS: DataTableColumn[] = [{ id: "bucketStart", label: "Hour (UTC)", width: 22, flexGrow: 1, align: "left" },
  { id: "researchUnits", label: "Research hrs", width: 14, align: "right" }, { id: "change", label: "Change", width: 11, align: "right" }];
export function attentionRows(rows: readonly AttentionRow[], tab: AttentionTab, query: string, column: string, direction: "asc" | "desc") {
  const filtered = rows.filter((row) => (tab !== "abnormal" || row.zScore !== null)
    && [row.symbol, row.name, row.country, row.sector].join(" ").toLowerCase().includes(query.trim().toLowerCase()));
  return [...filtered].sort((a, b) => {
    const left = a[column as keyof AttentionRow], right = b[column as keyof AttentionRow];
    if (left == null || right == null) return left == null ? right == null ? a.symbol.localeCompare(b.symbol) : 1 : -1;
    const result = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
    return (direction === "asc" ? result : -result) || a.symbol.localeCompare(b.symbol);
  });
}
export function rowCell(row: AttentionRow, column: string) {
  const value = row[column as keyof AttentionRow];
  if (column === "zScore") return signed(row.zScore);
  if (column === "priceChangePct") return signed(row.priceChangePct, "%");
  if (column === "relativeVolume") return row.relativeVolume === null ? "--" : `${number(row.relativeVolume, 2)}x`;
  if (column === "sharePct") return number(row.sharePct, 1);
  return typeof value === "number" ? number(value) : typeof value === "string" ? value : "--";
}
export const emptyAttention = (data: AttentionPayload | null | undefined) => data?.status === "disabled"
  ? "Research attention collection is not enabled yet." : "Waiting for privacy-qualified research activity.";

/** An unpublished hour is a gap, never a measured zero or an interpolated count. */
export function historyPoints(history: readonly AttentionPoint[]) {
  const points = [...history].sort((a, b) => a.bucketStart.localeCompare(b.bucketStart));
  const result: Array<{ date: Date; observedAt: Date; value: number | null }> = [];
  for (const point of points) {
    const at = Date.parse(point.bucketStart);
    const previous = result.at(-1)?.date.getTime();
    if (previous !== undefined) for (let gap = previous + 3_600_000; gap < at && gap - previous < 28 * 86_400_000; gap += 3_600_000)
      result.push({ date: new Date(gap), observedAt: new Date(gap), value: null });
    result.push({ date: new Date(at), observedAt: new Date(at), value: point.researchUnits });
  }
  return result;
}
