import { MISSING_VALUE } from "../../../utils/format";
import type { FundChange, FundMember, FundMembersPayload, MemberFundsPayload, StockFund, StockFundsPayload } from "../../../api-client/members";
import type { DataTableColumn } from "../../../components";
import { buildSectionedRows, type SectionedRow } from "../../../components/data-table/sections";
import { getTableWidth } from "../../../components/ui/table-layout";
import { isRegularSessionTime, latestRegularSessionClose } from "../../../market-data/market/freshness";
import { listingSuffixExchange, listingSuffixVenue } from "../../../sources/listing-symbols";
import { isUsOtcVenue, parsePublicTickerKey } from "../../../utils/exchanges";
import { listingAbroadVenue, nonUsSecListingVenue } from "../../../utils/sec";
import { compareSortValues, type SortPreference } from "../../../utils/sort-values";
import { rankTickerMatches } from "../../../utils/ticker-match-order";
import { closeLabel } from "../themes/model";
import { WORLD_INDICES } from "../world-indices/indices";
export type MembersTab = "members" | "movers" | "changes" | "breadth";
export const TABS = [{ value: "members", label: "Members" }, { value: "movers", label: "Movers" }, { value: "changes", label: "Changes" }, { value: "breadth", label: "Breadth" }];
export const isTab = (value: unknown): value is MembersTab => TABS.some((tab) => tab.value === value);
const COVERED = [{ ticker: "IVV", name: "S&P 500" }, { ticker: "IJH", name: "S&P 400" }, { ticker: "IJR", name: "S&P 600" }, { ticker: "IWM", name: "Russell 2000" }, { ticker: "IWB", name: "Russell 1000" }];
/** Symbols the app reads as a covered fund before asking the server, which knows its own aliases too. SPY is a fund of its own, with its own holdings. */
const LOCAL_ALIASES: Record<string, string> = { SPX: "IVV", "^SPX": "IVV", "^GSPC": "IVV", "^MID": "IJH", SP400: "IJH", "^SP400": "IJH", "^SML": "IJR", SP600: "IJR", "^SP600": "IJR", RUT: "IWM", "^RUT": "IWM", RUI: "IWB", "^RUI": "IWB" };
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
/** An index MEMB was asked for: its symbol where known (^GDAXI) and its name (DAX). */
export interface MemberIndex { symbol: string | null; name: string }
/** How an index's name compares: capitals, single spaces, no closing "Index" (Hang Seng Index is HANG SENG). */
const indexNameKey = (text: string) => text.trim().toUpperCase().replace(/\s+/g, " ").replace(/ INDEX$/, "");
/**
 * The index an input names, read once no covered fund answers to it: a caret symbol (^GDAXI, ^N225), named as
 * the world indices name it, or an index's name (HANG SENG, Nikkei 225 Index). A name a ticker could be (DAX,
 * KOSPI) stays a ticker, so the funds holding that listing are still looked for. Null for anything else.
 */
export function memberIndex(input: string): MemberIndex | null {
  const typed = input.trim();
  if (!typed || typed.includes(":")) return null;
  if (typed.startsWith("^")) {
    const symbol = typed.toUpperCase();
    return { symbol, name: WORLD_INDICES.find((entry) => entry.symbol.toUpperCase() === symbol)?.name ?? symbol };
  }
  if (/^[A-Z][A-Z0-9.-]{0,9}$/i.test(typed)) return null;
  const entry = WORLD_INDICES.find((item) => item.symbol.startsWith("^") && indexNameKey(item.name) === indexNameKey(typed));
  return entry ? { symbol: entry.symbol, name: entry.name } : null;
}
/**
 * What MEMB of an index no covered fund stands for reads: that its members are not covered, and where the
 * covered funds and indexes are listed, as a command for the report and as the function for the pane.
 */
export function indexNotCoveredMessage(index: MemberIndex, surface: "report" | "pane" = "report") {
  const named = index.symbol && index.symbol !== index.name ? `${index.name} (${index.symbol})` : index.name;
  return { title: `${named} members are not covered.`,
    message: surface === "pane" ? "MEMB with no fund lists the funds and indexes it covers." : "The covered funds and indexes: gloom fn MEMB." };
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
/** "S&P 500, IVV holdings as of 2026-10-08 (for SPX)": the holdings file the members come from. */
export function holdingsSourceText(input: string, data: Pick<FundMembersPayload, "fund" | "asOf" | "basis" | "filedOn">) {
  const requested = requestedSymbol(input);
  const forRequested = requested && requested !== data.fund.ticker ? ` (for ${requested})` : "";
  if (data.basis === "nport") return `${fundName(data.fund)}, ${data.fund.ticker} ${holdingsBasisText(data)}${forRequested}`;
  return `${fundName(data.fund)}, ${data.fund.ticker} holdings as of ${data.asOf.slice(0, 10)}${forRequested}`;
}
/**
 * What a fund holding a stock holds it as of, on its row: an N-PORT report's period end and filing day ("as of
 * 30 Jun 2026 (N-PORT, filed 26 Aug)"), or a daily file's date ("as of 5 Nov 2026 (daily file)"). A narrow
 * table drops the words its section header says ("30 Jun 2026, filed 26 Aug").
 */
export function stockFundAsOf(row: Pick<StockFund, "asOf" | "basis" | "filedOn">, short = false) {
  const asOf = dayMonth(row.asOf, true);
  const filed = row.basis === "nport" && row.filedOn ? `filed ${dayMonth(row.filedOn, row.filedOn.slice(0, 4) !== row.asOf.slice(0, 4))}` : "";
  if (short) return filed ? `${asOf}, ${filed}` : asOf;
  return row.basis === "nport" ? `as of ${asOf} (N-PORT${filed ? `, ${filed}` : ""})` : `as of ${asOf} (daily file)`;
}
const count = (value: number, noun = "") => `${value.toLocaleString("en-US")}${noun ? ` ${noun}${value === 1 ? "" : "s"}` : ""}`;
/**
 * What the funds holding a stock are: how many ETFs were looked through (the covered funds on their daily files,
 * every other US ETF from its latest N-PORT report), and that a report's holdings are a quarter's, filed up to
 * 60 days after the date they are as of.
 */
export function stockFundsNotices(data: StockFundsPayload) {
  const total = data.coverage.daily + data.coverage.nport;
  const holders = new Set(data.funds.map((row) => row.ticker)).size;
  const position = data.funds.some((row) => row.holdingType === "adr") ? `shares or ADRs for ${data.symbol}` : data.symbol;
  return [
    `${count(holders)} of ${count(total)} ETFs looked through hold ${position}: ${count(data.coverage.daily, "covered fund")} from daily holdings files, ${count(data.coverage.nport)} from their latest SEC N-PORT reports.`,
    ...(data.funds.some((row) => row.basis === "nport") ? ["N-PORT holdings are a quarter's report, filed up to 60 days after the date they are as of."] : []),
  ];
}
/** Where a covered fund's holdings come from, for the fund list: its issuer's daily file, or its N-PORT report and the day it was filed. */
export function fundSource(fund: { basis?: "daily" | "nport"; filedOn?: string | null; asOf: string | null }) {
  if (fund.basis !== "nport") return "Daily file";
  return fund.filedOn ? `N-PORT, filed ${dayMonth(fund.filedOn, true)}` : "N-PORT";
}
export function stockListingInput(input: string, venue?: string): string {
  const { symbol, exchange } = parsePublicTickerKey(input);
  const abroad = exchange ? nonUsSecListingVenue(input) : venue ? listingAbroadVenue(`${symbol}:${venue}`) : null;
  if (abroad && !isUsOtcVenue(abroad)) return `${listingSuffixVenue(symbol, abroad)?.symbol ?? symbol}:${abroad}`;
  const suffixed = exchange || venue ? null : listingSuffixVenue(symbol, /^\d/.test(symbol) ? listingSuffixExchange(symbol) : undefined);
  return suffixed ? `${suffixed.symbol}:${suffixed.exchange}` : symbol;
}
/** No ETF looked through holds the symbol: it may be a fund MEMB does not cover, so the fund facts are named too. */
export function noStockFundsMessage(input: string, surface: "report" | "pane" = "report") {
  const listing = stockListingInput(input);
  if (listing.includes(":")) return { title: `No ETF looked through holds ${listing}.`, message: "" };
  const symbol = requestedSymbol(input);
  return { title: `No ETF looked through holds ${symbol}.`,
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
    ...(data.excludedShorts ? [`${data.excludedShorts} short positions are excluded from these share holdings.`] : []),
    ...(data.positions && data.positions > data.members.length ? [`The largest ${count(data.members.length)} of ${count(data.positions)} positions are listed${
      data.omittedWeight != null && Number.isFinite(data.omittedWeight) ? `; the rest are ${decimal(data.omittedWeight * 100, 1)}% of the fund` : ""}.`] : []),
  ];
}
/** A fund's own name: an N-PORT fund's served `name` says "(N-PORT)" for apps that cannot show its basis. */
export function fundName(fund: { name: string; plainName?: string }) {
  return fund.plainName ?? fund.name;
}
export function membersTitle(input: string, stock = false) {
  const listing = stockListingInput(input);
  if (stock && listing.includes(":")) return `Funds holding ${listing}`;
  const requested = input.split(":")[0]!.trim().toUpperCase();
  const fund = canonicalFund(requested);
  const definition = COVERED.find((item) => item.ticker === fund);
  return definition ? `${definition.name}, ${fund} holdings${requested !== fund ? ` (${requested})` : ""}`
    : stock ? `Funds holding ${requested}` : requested ? `MEMB ${requested}` : "Index and ETF members";
}
export const DEFAULT_SORT: SortPreference<string> = { columnId: "weight", direction: "desc" };
/** A signed figure; one that rounds to zero is unsigned (0.00, never +0.00 or -0.00). */
export function percent(value: number | null, suffix = "%", digits = 2) {
  if (value == null || !Number.isFinite(value)) return MISSING_VALUE;
  const fixed = value.toFixed(digits);
  if (!/[1-9]/.test(fixed)) return `${fixed.replace("-", "")}${suffix}`;
  return `${value > 0 ? "+" : ""}${fixed}${suffix}`;
}
export const decimal = (value: number | null, digits = 2) => value == null || !Number.isFinite(value) ? MISSING_VALUE : value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
export function sortMembers(rows: readonly FundMember[], sort: SortPreference<string>) {
  return [...rows].sort((a, b) => compareSortValues(a[sort.columnId as keyof FundMember] as number | string | null,
    b[sort.columnId as keyof FundMember] as number | string | null, sort.direction) || a.id.localeCompare(b.id));
}
export function memberRows(rows: readonly FundMember[], tab: MembersTab, query: string, sort: SortPreference<string>): SectionedRow<FundMember>[] {
  const needle = query.trim().toLowerCase();
  const filtered = rows.filter((row) => `${row.symbol ?? ""} ${row.name} ${row.sector ?? ""}`.toLowerCase().includes(needle));
  const fields = (row: FundMember) => [row.symbol, row.name] as const;
  if (tab !== "movers") return rankTickerMatches(sortMembers(filtered, sort), query, fields).map((item) => ({ kind: "item", key: item.id, item }));
  const ranked = sortMembers(filtered.filter((row) => row.contribution !== null), { columnId: "contribution", direction: "desc" });
  return buildSectionedRows([
    { label: "Contributors", items: rankTickerMatches(ranked.filter((row) => row.contribution! > 0), query, fields).slice(0, 10) },
    { label: "Detractors", items: rankTickerMatches(ranked.filter((row) => row.contribution! < 0).reverse(), query, fields).slice(0, 10) },
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
    column("changePercent", "1D", compact ? 8 : 9), ...(!movers ? [column("return1WPercent", "1W", 9), column("return1MPercent", "1M", 9), column("returnYtdPercent", "YTD", 9),
      // Most sponsors' holdings files give no sector (SPDR's, Invesco's, Vanguard's); iShares' do.
      { ...column("sector", "Sector", 22, "left"), omitWhenEmpty: true }] : [])], width,
    ["sector", "shares", "returnYtdPercent", "return1MPercent", "return1WPercent", "price", "name"]);
}
export function stockHoldingLabel(row: StockFund): string | undefined {
  if (row.holdingType === "ordinary") return "Ordinary shares";
  if (row.holdingType === "adr") return row.receiptTicker ? `ADR (${row.receiptTicker})` : "ADR";
}
export function stockFundRows(rows: readonly StockFund[]): SectionedRow<StockFund>[] {
  const groups = [...new Set(rows.map(stockHoldingLabel))].sort((left, right) =>
    Number(left !== "Ordinary shares") - Number(right !== "Ordinary shares") || (left ?? "").localeCompare(right ?? ""));
  return buildSectionedRows(groups.flatMap((group) => [
    { label: group ? `${group} · Daily holdings files` : "Daily holdings files", items: rows.filter((row) => stockHoldingLabel(row) === group && row.basis === "daily") },
    { label: group ? `${group} · SEC N-PORT reports` : "SEC N-PORT reports", items: rows.filter((row) => stockHoldingLabel(row) === group && row.basis === "nport") },
  ]), (row) => row.holdingType ? `${row.ticker}:${row.holdingType}:${row.receiptTicker ?? ""}` : row.ticker);
}
/** Whether a stock's fund table has room for each row's whole "as of 30 Jun 2026 (N-PORT, filed 26 Aug)". */
export const stockFundAsOfFits = (width: number) => width >= 96;
export function stockFundColumns(width: number) {
  const compact = width < 50;
  const whole = stockFundAsOfFits(width);
  return fit([column("ticker", "Fund", 8, "left"), column("name", "Name", whole ? 24 : 14, "left"), column("weight", compact ? "Wt. %" : "Weight %", compact ? 7 : 10),
    column("asOf", whole ? "Holdings" : "As of", whole ? 46 : compact ? 26 : 30, "left")], width, ["name"]);
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
