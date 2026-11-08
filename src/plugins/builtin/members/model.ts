import type { FundChange, FundMember, FundMembersPayload, MemberFundsPayload, StockFund, StockFundsPayload } from "../../../api-client/members";
import type { DataTableColumn } from "../../../components";
import { buildSectionedRows, type SectionedRow } from "../../../components/data-table/sections";
import { getTableWidth } from "../../../components/ui/table-layout";
import { isRegularSessionTime, latestRegularSessionClose } from "../../../market-data/market/freshness";
import { isUsListingExchange } from "../../../utils/exchanges";
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
/**
 * What a fund MEMB does not cover reads: that it is not covered, and where its fund facts and the covered list are,
 * as a command (`gloom fn ETF SMH`) for the report and as a function for the pane. Never the whole covered list.
 */
export function notCoveredMessage(input: string, surface: "report" | "pane" = "report") {
  const symbol = requestedSymbol(input);
  const title = `${symbol} is not a covered fund.`;
  const message = surface === "pane" ? `Its fund facts are in ETF ${symbol}. MEMB with no fund lists the funds it covers.`
    : `Its fund facts: gloom fn ETF ${symbol}. The covered funds: gloom fn MEMB.`;
  return { title, message };
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
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "31 Jul 2026", or "22 Sep": spelled out here, as a renderer's locale data writes September "Sept". */
const dayMonth = (date: string, year: boolean) => {
  const [y, m, d] = date.slice(0, 10).split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]}${year ? ` ${y}` : ""}`;
};
/**
 * What a fund's holdings are as of: an issuer file's date ("holdings 2026-10-08"), or for an N-PORT report its
 * period end and filing day ("holdings as of 31 Jul 2026 (N-PORT, filed 22 Sep)"), so a quarter-old report never
 * reads as today's holdings. The filing day names its year when it is not the report's.
 */
export function holdingsBasisText(data: { asOf: string; basis?: "daily" | "nport"; filedOn?: string | null }, short = false) {
  if (data.basis !== "nport") return `holdings ${data.asOf.slice(0, 10)}`;
  const filed = data.filedOn ? `, filed ${dayMonth(data.filedOn, data.filedOn.slice(0, 4) !== data.asOf.slice(0, 4))}` : "";
  // A narrow footer: "N-PORT 31 Jul 2026, filed 22 Sep".
  return short ? `N-PORT ${dayMonth(data.asOf, true)}${filed}` : `holdings as of ${dayMonth(data.asOf, true)} (N-PORT${filed})`;
}
/** "S&P 500, IVV holdings as of 2026-10-08 (for SPY)": the holdings file the members come from. */
export function holdingsSourceText(input: string, data: Pick<FundMembersPayload, "fund" | "asOf" | "basis" | "filedOn">) {
  const requested = requestedSymbol(input);
  const forRequested = requested && requested !== data.fund.ticker ? ` (for ${requested})` : "";
  if (data.basis === "nport") return `${data.fund.name}, ${data.fund.ticker} ${holdingsBasisText(data)}${forRequested}`;
  return `${data.fund.name}, ${data.fund.ticker} holdings as of ${data.asOf.slice(0, 10)}${forRequested}`;
}
/**
 * What the funds holding a stock are: how many covered funds were looked through, and that the N-PORT funds'
 * holdings are a quarter's report, filed up to 60 days after the date it is as of.
 */
export function stockFundsNotices(data: StockFundsPayload) {
  return [
    `Looked through ${data.coverage.daily + data.coverage.nport} covered funds: ${data.coverage.daily} from daily holdings files, ${data.coverage.nport} from SEC N-PORT reports.`,
    ...(data.funds.some((row) => row.basis === "nport") ? ["N-PORT holdings are a quarter's report, filed up to 60 days after the date they are as of."] : []),
  ];
}
/** Where a covered fund's holdings come from, for the fund list: its issuer's daily file, or its N-PORT report and the day it was filed. */
export function fundSource(fund: { basis?: "daily" | "nport"; filedOn?: string | null; asOf: string | null }) {
  if (fund.basis !== "nport") return "Daily file";
  return fund.filedOn ? `N-PORT, filed ${dayMonth(fund.filedOn, true)}` : "N-PORT";
}
/**
 * The US ticker a look-through asks for (NVDA, BRK.B), from a bare symbol or a US listing; null for a listing abroad
 * (INFY:NSE), whose code is not the ticker the funds' holdings carry.
 */
export function usListingInput(input: string): string | null {
  const [symbol, exchange] = input.trim().toUpperCase().split(":");
  return symbol && (!exchange || isUsListingExchange(exchange)) ? symbol : null;
}
/** Nothing covered holds the symbol: it may be a fund MEMB does not cover, so the fund facts are named too. */
export function noStockFundsMessage(input: string, surface: "report" | "pane" = "report") {
  const symbol = requestedSymbol(input);
  return { title: `No covered fund holds ${symbol}.`,
    message: surface === "pane" ? `If ${symbol} is a fund, MEMB does not cover it: its fund facts are in ETF ${symbol}. MEMB with no fund lists the funds it covers.`
      : `If ${symbol} is a fund, MEMB does not cover it: gloom fn ETF ${symbol}. The covered funds: gloom fn MEMB.` };
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
export function membersTitle(input: string, stock = false) {
  const requested = input.split(":")[0]!.trim().toUpperCase();
  const fund = canonicalFund(requested);
  const definition = COVERED.find((item) => item.ticker === fund);
  return definition ? `${definition.name}, ${fund} holdings${requested !== fund ? ` (${requested})` : ""}`
    : stock ? `Funds holding ${requested}` : requested ? `MEMB ${requested}` : "Index and ETF members";
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
/** The funds holding a stock, in two sections: those on daily holdings files, then those read from N-PORT reports, each by weight as the server orders them. */
export function stockFundRows(rows: readonly StockFund[]): SectionedRow<StockFund>[] {
  return buildSectionedRows([
    { label: "Daily holdings files", items: rows.filter((row) => row.basis === "daily") },
    { label: "SEC N-PORT reports", items: rows.filter((row) => row.basis === "nport") },
  ], (row) => row.ticker);
}
export function stockFundColumns(width: number) {
  const compact = width < 50;
  return fit([column("ticker", "Fund", 8, "left"), column("name", "Theme", 24, "left"), column("weight", compact ? "Wt. %" : "Weight %", compact ? 7 : 10),
    column("asOf", "As of", 12, "left"), column("filedOn", "Filed", 12, "left")], width, ["filedOn", "name"]);
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
