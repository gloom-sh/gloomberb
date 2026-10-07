import type { FundChange, FundMember } from "../../../api-client/members";
import type { DataTableColumn } from "../../../components";
import { buildSectionedRows, type SectionedRow } from "../../../components/data-table/sections";
import { getTableWidth } from "../../../components/ui/table-layout";
import { compareSortValues, type SortPreference } from "../../../utils/sort-values";
export type MembersTab = "members" | "movers" | "changes";
export const TABS = [{ value: "members", label: "Members" }, { value: "movers", label: "Movers" }, { value: "changes", label: "Changes" }];
export const isTab = (value: unknown): value is MembersTab => TABS.some((tab) => tab.value === value);
export const COVERED = [{ ticker: "IVV", name: "S&P 500" }, { ticker: "IJH", name: "S&P 400" }, { ticker: "IJR", name: "S&P 600" }, { ticker: "IWM", name: "Russell 2000" }, { ticker: "IWB", name: "Russell 1000" }];
export function canonicalFund(input: string) { const symbol = input.split(":")[0]!.trim().toUpperCase(); return ["SPX", "SPY", "^GSPC"].includes(symbol) ? "IVV" : symbol; }
export function membersTitle(input: string) {
  const requested = input.split(":")[0]!.trim().toUpperCase();
  const fund = canonicalFund(requested);
  const definition = COVERED.find((item) => item.ticker === fund);
  return definition ? `${definition.name}, ${fund} holdings${requested !== fund ? ` (${requested})` : ""}`
    : requested ? `MEMB ${requested}` : "Index and ETF members";
}
export const DEFAULT_SORT: SortPreference<string> = { columnId: "weight", direction: "desc" };
export const percent = (value: number | null, suffix = "%") => value == null || !Number.isFinite(value) ? "--" : `${value > 0 ? "+" : ""}${value.toFixed(2)}${suffix}`;
export const decimal = (value: number | null, digits = 2) => value == null || !Number.isFinite(value) ? "--" : value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
export function sortMembers(rows: readonly FundMember[], sort: SortPreference<string>) {
  return [...rows].sort((a, b) => compareSortValues(a[sort.columnId as keyof FundMember] as number | string | null,
    b[sort.columnId as keyof FundMember] as number | string | null, sort.direction) || a.id.localeCompare(b.id));
}
export function memberRows(rows: readonly FundMember[], tab: MembersTab, query: string, sort: SortPreference<string>): SectionedRow<FundMember>[] {
  const needle = query.trim().toLowerCase();
  const filtered = rows.filter((row) => `${row.symbol ?? ""} ${row.name} ${row.sector ?? ""}`.toLowerCase().includes(needle));
  if (tab !== "movers") return sortMembers(filtered, sort).map((item) => ({ kind: "item", key: item.id, item }));
  const ranked = sortMembers(filtered.filter((row) => row.contribution !== null), { columnId: "contribution", direction: "desc" });
  return buildSectionedRows([
    { label: "Contributors", items: ranked.filter((row) => row.contribution! > 0).slice(0, 10) },
    { label: "Detractors", items: ranked.filter((row) => row.contribution! < 0).reverse().slice(0, 10) },
  ], (row) => row.id);
}
const column = (id: string, label: string, width: number, align: "left" | "right" = "right"): DataTableColumn => ({ id, label, width, align });
function fit(columns: DataTableColumn[], width: number, drops: string[]) {
  for (const id of drops) { if (getTableWidth(columns) <= width) break; columns = columns.filter((col) => col.id !== id); }
  const flexible = columns.find((col) => col.id === "name" || col.id === "reason") ?? columns[0]!;
  flexible.width = Math.max(6, flexible.width + Math.max(0, width - getTableWidth(columns)));
  flexible.flexGrow = 1;
  return columns;
}
export function memberColumns(width: number, movers = false): DataTableColumn[] {
  const compact = width < 50;
  return fit([column("symbol", "Ticker", 8, "left"), column("name", "Name", 22, "left"),
    column("weight", compact ? "Wt. %" : "Weight %", compact ? 7 : 10), ...(movers ? [column("contribution", compact ? "pp" : "Contrib. pp", compact ? 7 : 13)] : []),
    ...(!movers ? [column("shares", "Shares", 14), column("price", "Price $", 11)] : []),
    column("changePercent", "1D", compact ? 8 : 9), ...(!movers ? [column("return1WPercent", "1W", 9), column("return1MPercent", "1M", 9), column("returnYtdPercent", "YTD", 9), column("sector", "Sector", 22, "left")] : [])], width,
    ["sector", "shares", "returnYtdPercent", "return1MPercent", "return1WPercent", "price", "name"]);
}
export function changeColumns(width: number) {
  const compact = width < 50;
  return fit([column("effectiveDate", compact ? "Date" : "Effective", compact ? 10 : 12, "left"), column("daysToGo", compact ? "In" : "In days", compact ? 4 : 9), column("added", "Added", compact ? 7 : 8, "left"), column("removed", "Removed", 9, "left"), column("estimate", "Est. ADV days", 15), column("reason", "Reason", 28, "left")], width, ["estimate", "reason"]);
}
export const changeLabel = (row: FundChange) => row.added && row.removed ? `${row.added} replaces ${row.removed}`
  : row.added ? `${row.added} added` : row.removed ? `${row.removed} removed` : "Index announcement";
export function changeReason(row: FundChange) {
  if (row.kind !== "announcement" || row.reason !== row.headline || !row.added && !row.removed) return row.reason;
  return row.added && row.removed ? "Index replacement" : row.added ? "Index addition" : "Index deletion";
}
