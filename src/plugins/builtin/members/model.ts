import type { FundChange, FundMember, FundMembersPayload, MemberFundsPayload } from "../../../api-client/members";
import type { DataTableColumn } from "../../../components";
import { buildSectionedRows, type SectionedRow } from "../../../components/data-table/sections";
import { getTableWidth } from "../../../components/ui/table-layout";
import { isRegularSessionTime, latestRegularSessionClose } from "../../../market-data/market/freshness";
import { compareSortValues, type SortPreference } from "../../../utils/sort-values";
import { closeLabel } from "../themes/model";
export type MembersTab = "members" | "movers" | "changes" | "breadth";
export const TABS = [{ value: "members", label: "Members" }, { value: "movers", label: "Movers" }, { value: "changes", label: "Changes" }, { value: "breadth", label: "Breadth" }];
export const isTab = (value: unknown): value is MembersTab => TABS.some((tab) => tab.value === value);
const COVERED = [{ ticker: "IVV", name: "S&P 500" }, { ticker: "IJH", name: "S&P 400" }, { ticker: "IJR", name: "S&P 600" }, { ticker: "IWM", name: "Russell 2000" }, { ticker: "IWB", name: "Russell 1000" }];
/** Symbols the app reads as a covered fund before asking the server, which knows its own aliases too. */
const LOCAL_ALIASES: Record<string, string> = { SPX: "IVV", "^SPX": "IVV", SPY: "IVV", "^GSPC": "IVV", "^MID": "IJH", SP400: "IJH", "^SP400": "IJH", "^SML": "IJR", SP600: "IJR", "^SP600": "IJR", RUT: "IWM", "^RUT": "IWM", RUI: "IWB", "^RUI": "IWB" };
const requestedSymbol = (input: string) => input.split(":")[0]!.trim().toUpperCase();
export function canonicalFund(input: string) { const symbol = requestedSymbol(input); return LOCAL_ALIASES[symbol] ?? symbol; }
/** The covered fund the user asked for, by ticker or by an alias such as SPX, or undefined when it is not covered. */
export function coveredFund(funds: MemberFundsPayload["funds"], input: string) {
  const symbol = canonicalFund(input);
  return funds.find((fund) => fund.ticker === symbol || fund.aliases.some((alias) => alias.toUpperCase() === symbol));
}
/** Every symbol that opens this fund: the server's aliases and the app's own. */
function fundAliases(fund: MemberFundsPayload["funds"][number]) {
  const local = Object.entries(LOCAL_ALIASES).flatMap(([alias, ticker]) => ticker === fund.ticker ? [alias] : []);
  return [...new Set([...fund.aliases.map((alias) => alias.toUpperCase()), ...local])].filter((alias) => alias !== fund.ticker);
}
export function notCoveredMessage(input: string, funds: MemberFundsPayload["funds"]) {
  const covered = funds.map((fund) => { const aliases = fundAliases(fund); return aliases.length ? `${fund.ticker} (${aliases.join(", ")})` : fund.ticker; });
  return `${requestedSymbol(input)} is not a covered fund. Covered: ${covered.join(", ")}.`;
}
/** "Partial 1D 334/504 · 91.5% wt": how many holdings have a fresh 1D return, and their share of the fund. */
export function coverageText(aggregate: FundMembersPayload["aggregate"], short = false) {
  const partial = aggregate.fresh1D < aggregate.total;
  return `${partial && !short ? "Partial " : ""}1D ${aggregate.fresh1D}/${aggregate.total} · ${decimal(aggregate.coveredWeight * 100, 1)}% wt`;
}
/**
 * What a fund's member quotes are, as read at `readAt`. A Pro account's are live while the regular US session
 * trades; outside it the server prices the members from the last completed session, so they are that session's
 * close (`Fri 23 Oct close`), as THEM names it, never live. Everyone else's are 15 minutes delayed, in or out of
 * a session. Hours that cannot be told read as live.
 */
export function membersFeed(access: FundMembersPayload["access"], readAt: number): { kind: "live" | "delayed" } | { kind: "close"; date: string; closedAt: number; label: string } {
  if (access !== "realtime") return { kind: "delayed" };
  const close = isRegularSessionTime("NYSE", readAt) === false ? latestRegularSessionClose("NYSE", readAt) : null;
  return close ? { kind: "close", date: close.date, closedAt: close.close, label: closeLabel(close.date) } : { kind: "live" };
}
/** "S&P 500, IVV holdings as of 2026-10-08 (for SPY)": the holdings file the members come from. */
export function holdingsSourceText(input: string, data: Pick<FundMembersPayload, "fund" | "asOf">) {
  const requested = requestedSymbol(input);
  return `${data.fund.name}, ${data.fund.ticker} holdings as of ${data.asOf.slice(0, 10)}${requested && requested !== data.fund.ticker ? ` (for ${requested})` : ""}`;
}
/** Caveats about a fund's holdings and returns, shared by the pane's notices and the text report. */
export function holdingsCaveats(data: FundMembersPayload, movers: boolean) {
  return [
    ...(data.quotesUnavailable ? ["Member returns and current prices are unavailable. Dated holdings remain available."] : []),
    ...(movers && data.aggregate.fundReturn === null ? ["Fund 1D is unavailable; the difference cannot be calculated."] : []),
    ...(movers && data.aggregate.withinTolerance === false ? [`The covered contribution sum differs from the fund by ${percent(data.aggregate.residual, " pp")}.`] : []),
    ...(data.excludedDerivatives ? [`${data.excludedDerivatives} derivative positions are excluded from these share holdings.`] : []),
  ];
}
export function membersTitle(input: string) {
  const requested = input.split(":")[0]!.trim().toUpperCase();
  const fund = canonicalFund(requested);
  const definition = COVERED.find((item) => item.ticker === fund);
  return definition ? `${definition.name}, ${fund} holdings${requested !== fund ? ` (${requested})` : ""}`
    : requested ? `MEMB ${requested}` : "Index and ETF members";
}
export const DEFAULT_SORT: SortPreference<string> = { columnId: "weight", direction: "desc" };
/** A signed figure; one that rounds to zero is unsigned (0.00, never +0.00 or -0.00). */
export function percent(value: number | null, suffix = "%", digits = 2) {
  if (value == null || !Number.isFinite(value)) return "--";
  const fixed = value.toFixed(digits);
  if (!/[1-9]/.test(fixed)) return `${fixed.replace("-", "")}${suffix}`;
  return `${value > 0 ? "+" : ""}${fixed}${suffix}`;
}
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
