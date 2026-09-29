import type { IpoDeal, IpoRegion, IpoSourceHealth, IpoStatus } from "../../../api-client/ipo";
import type { DataTableColumn } from "../../../components";
import { getTableWidth } from "../../../components/ui/table-layout";
import { publicTickerKey } from "../../../utils/exchanges";
import { displayWidth, formatCompact } from "../../../utils/format";
import { compareSortValues, type SortPreference } from "../../../utils/sort-values";

export const IPO_CALENDAR_PANE_ID = "ipo-calendar";
export const MISSING = "—";

export type IpoTab = "all" | Exclude<IpoRegion, "other">;

/** Deals outside the three regions show only under All. */
export const IPO_TABS: readonly { value: IpoTab; label: string }[] = [
  { value: "all", label: "All" },
  { value: "us", label: "US" },
  { value: "apac", label: "APAC" },
  { value: "europe", label: "Europe" },
];

export function isIpoTab(value: unknown): value is IpoTab {
  return IPO_TABS.some((tab) => tab.value === value);
}

/** Every status, in the order a deal moves through them. */
export const IPO_STATUSES: readonly IpoStatus[] = ["filed", "upcoming", "priced", "listed", "postponed", "withdrawn"];

/**
 * The market each venue answers to when its data is behind. A venue the
 * server adds later reads as its MIC until it has a name here.
 */
const MARKETS: Record<string, { market: string; region: IpoRegion }> = {
  XNAS: { market: "US", region: "us" },
  XNYS: { market: "US", region: "us" },
  XASE: { market: "US", region: "us" },
  XHKG: { market: "Hong Kong", region: "apac" },
  XSHG: { market: "China", region: "apac" },
  XSHE: { market: "China", region: "apac" },
  XNSE: { market: "India", region: "apac" },
  XTKS: { market: "Japan", region: "apac" },
  XASX: { market: "Australia", region: "apac" },
  XLON: { market: "UK", region: "europe" },
  XPAR: { market: "France", region: "europe" },
  XAMS: { market: "Netherlands", region: "europe" },
  XBRU: { market: "Belgium", region: "europe" },
  XLIS: { market: "Portugal", region: "europe" },
  XMIL: { market: "Italy", region: "europe" },
  XDUB: { market: "Ireland", region: "europe" },
  XOSL: { market: "Norway", region: "europe" },
  XSTO: { market: "Sweden", region: "europe" },
  XHEL: { market: "Finland", region: "europe" },
  XCSE: { market: "Denmark", region: "europe" },
  XSWX: { market: "Switzerland", region: "europe" },
  XETR: { market: "Germany", region: "europe" },
  XFRA: { market: "Germany", region: "europe" },
};

/**
 * Markets the board cannot vouch for on this tab: a venue is behind when no
 * source covering it answered, so a failed cross-check alone behind a working
 * exchange feed is not a gap.
 */
export function marketsBehind(sources: readonly IpoSourceHealth[], tab: IpoTab, deals: readonly IpoDeal[] = []): string[] {
  const covered = new Map<string, boolean>();
  for (const source of sources) {
    for (const mic of source.mics) covered.set(mic, (covered.get(mic) ?? false) || source.ok);
  }
  const markets: string[] = [];
  for (const [mic, ok] of covered) {
    if (ok) continue;
    const known = MARKETS[mic];
    const region = known?.region ?? deals.find((deal) => deal.mic === mic)?.region ?? "other";
    if (tab !== "all" && region !== tab) continue;
    const market = known?.market ?? mic;
    if (!markets.includes(market)) markets.push(market);
  }
  return markets;
}

/** "India not updated", "UK, Switzerland and Germany not updated", "UK, France and 3 more not updated". */
export function marketsBehindText(markets: readonly string[]): string | null {
  if (markets.length === 0) return null;
  if (markets.length === 1) return `${markets[0]} not updated`;
  const named = markets.length <= 3
    ? `${markets.slice(0, -1).join(", ")} and ${markets.at(-1)}`
    : `${markets.slice(0, 2).join(", ")} and ${markets.length - 2} more`;
  return `${named} not updated`;
}

const countryNames = new Map<string, string>();
let regionNames: Intl.DisplayNames | null | undefined;

/** "Japan" for JP, so a search can name the country. */
function countryName(code: string): string {
  let name = countryNames.get(code);
  if (name === undefined) {
    try {
      regionNames ??= new Intl.DisplayNames(["en"], { type: "region" });
      name = regionNames.of(code) ?? "";
    } catch {
      name = "";
    }
    countryNames.set(code, name);
  }
  return name;
}

/** Company in either script, symbol, venue, country code or name, and status. */
export function matchesIpoQuery(deal: IpoDeal, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [
    deal.company, deal.companyLocal, deal.symbol, deal.venue, deal.mic, deal.exchange,
    deal.country, countryName(deal.country), deal.segment, deal.status,
  ].some((value) => !!value && value.toLowerCase().includes(needle));
}

export function filterIpoDeals(deals: readonly IpoDeal[], tab: IpoTab, query = ""): IpoDeal[] {
  return deals.filter((deal) => (tab === "all" || deal.region === tab) && matchesIpoQuery(deal, query));
}

export type IpoColumnId = "ticker" | "company" | "market" | "date" | "status" | "price" | "size" | "return";
export type IpoColumn = DataTableColumn & { id: IpoColumnId };
export type IpoSortPreference = SortPreference<IpoColumnId>;

/** No column: the calendar's own order. */
export const DEFAULT_IPO_SORT: IpoSortPreference = { columnId: null, direction: "asc" };

/** Upcoming first, then what priced or listed, then the pipeline, then deals that stopped. */
function calendarGroup(status: IpoStatus): number {
  switch (status) {
    case "upcoming": return 0;
    case "priced":
    case "listed": return 1;
    case "filed": return 2;
    case "postponed":
    case "withdrawn": return 3;
  }
}

/**
 * The date a deal sorts by in its group. An upcoming deal still in book
 * building may have its subscription window before a listing date, and a
 * deal priced on a Shenzhen or ASX book may have no listing date yet.
 */
export function calendarDate(deal: IpoDeal): string | null {
  switch (deal.status) {
    case "upcoming": return deal.listingDate ?? deal.subscriptionClose ?? deal.subscriptionOpen;
    case "priced":
    case "listed": return deal.listingDate ?? deal.firstDay?.session ?? deal.subscriptionClose ?? deal.subscriptionOpen;
    case "filed": return deal.filedDate ?? deal.listingDate;
    default: return deal.listingDate ?? deal.filedDate;
  }
}

/** Upcoming deals soonest first; everything after them most recent first. */
function compareCalendarOrder(a: IpoDeal, b: IpoDeal): number {
  const group = calendarGroup(a.status) - calendarGroup(b.status);
  if (group !== 0) return group;
  const date = compareSortValues(calendarDate(a), calendarDate(b), a.status === "upcoming" ? "asc" : "desc");
  return date || a.company.localeCompare(b.company) || a.id.localeCompare(b.id);
}

/**
 * Prices are in each deal's own currency, so across markets they sort in US
 * dollars at the rate the size was converted at: USD size over local size.
 */
function usdPrice(deal: IpoDeal): number | null {
  const price = deal.offerPrice ?? deal.priceLow ?? deal.priceHigh;
  if (price == null || deal.offerSize == null || deal.offerSizeUsd == null || deal.offerSize <= 0) return null;
  return price * (deal.offerSizeUsd / deal.offerSize);
}

function sortValue(columnId: IpoColumnId, deal: IpoDeal): string | number | null {
  switch (columnId) {
    case "ticker": return deal.symbol;
    case "company": return deal.company;
    case "market": return deal.venue;
    case "date": return calendarDate(deal);
    case "status": return IPO_STATUSES.indexOf(deal.status);
    case "price": return usdPrice(deal);
    case "size": return deal.offerSizeUsd;
    case "return": return deal.firstDay?.returnPct ?? null;
  }
}

export function sortIpoDeals(deals: readonly IpoDeal[], sort: IpoSortPreference): IpoDeal[] {
  const { columnId } = sort;
  if (!columnId) return [...deals].sort(compareCalendarOrder);
  return [...deals].sort((a, b) => (
    compareSortValues(sortValue(columnId, a), sortValue(columnId, b), sort.direction) || compareCalendarOrder(a, b)
  ));
}

/** Names read A to Z first; dates soonest first; numbers largest first. */
export function firstIpoSortDirection(columnId: IpoColumnId): "asc" | "desc" {
  return columnId === "price" || columnId === "size" || columnId === "return" ? "desc" : "asc";
}

const COMPANY_MIN_WIDTH = 16;

/** Every column at its narrowest; COMPANY takes what the pane has left. */
const IPO_COLUMNS: readonly IpoColumn[] = [
  // NSE symbols run to ten letters; the rest are far shorter.
  { id: "ticker", label: "TICKER", width: 10, align: "left" },
  { id: "company", label: "COMPANY", width: COMPANY_MIN_WIDTH, align: "left", flexGrow: 1 },
  // Sized to the board's longest venue, see marketColumnWidth.
  { id: "market", label: "MKT", width: 10, align: "left" },
  { id: "date", label: "DATE", width: 8, align: "left" },
  { id: "status", label: "STATUS", width: 9, align: "left" },
  // "HK$26.20-28.50".
  { id: "price", label: "PRICE", width: 14, align: "right" },
  // "$218.82M".
  { id: "size", label: "SIZE", width: 8, align: "right" },
  { id: "return", label: "RETURN", width: 8, align: "right" },
];

/**
 * What a narrow pane gives up first, so COMPANY and RETURN stay. SIZE is
 * only filled once terms are out, STATUS follows from the calendar's order,
 * the date and a return, and MKT goes before the date a deal lists on.
 */
const NARROW_DROP_ORDER: readonly IpoColumnId[] = ["size", "status", "price", "market", "date", "ticker"];

/** The table's own width for these columns, plus a cell for the scrollbar. */
export function ipoTableWidth(columns: readonly IpoColumn[]): number {
  return getTableWidth(columns) + 1;
}

/** MKT fits the longest venue on the board ("NYSE American"), and no wider. */
export function marketColumnWidth(deals: readonly IpoDeal[]): number {
  const longest = deals.reduce((max, deal) => Math.max(max, displayWidth(deal.venue || deal.mic)), 0);
  return Math.min(14, Math.max(5, longest));
}

export function buildIpoColumns(width: number, marketWidth = 10): IpoColumn[] {
  let columns = IPO_COLUMNS.map((column) => (column.id === "market" ? { ...column, width: marketWidth } : column));
  for (const id of NARROW_DROP_ORDER) {
    if (ipoTableWidth(columns) <= width) break;
    columns = columns.filter((column) => column.id !== id);
  }
  return columns;
}

/**
 * A deal the app can open, keyed on its own venue so `0700` or `7203` never
 * opens a US ticker. A venue with no exchange code (Dublin) has no key a
 * provider resolves, so its rows do not open.
 */
export function ipoTickerKey(deal: IpoDeal): string | null {
  if (!deal.symbol || !deal.exchange) return null;
  return publicTickerKey(deal.symbol, deal.exchange);
}

const CURRENCY_SIGNS: Record<string, string> = {
  USD: "$", HKD: "HK$", EUR: "€", GBP: "£", JPY: "¥", CNY: "¥", INR: "₹", KRW: "₩", AUD: "A$", CAD: "C$", SGD: "S$",
};

function amount(value: number): string {
  const whole = Math.abs(value - Math.round(value)) < 1e-9;
  return value.toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
}

/** "$18", "HK$26.20-28.50", "240-260p", "CHF 45": the offer price once set, else the range. */
export function formatIpoPrice(deal: IpoDeal): string {
  const low = deal.offerPrice ?? deal.priceLow ?? deal.priceHigh;
  if (low == null) return MISSING;
  const high = deal.offerPrice == null && deal.priceLow != null && deal.priceHigh != null && deal.priceHigh !== deal.priceLow
    ? deal.priceHigh
    : null;
  const figures = high == null ? amount(low) : `${amount(low)}-${amount(high)}`;
  const code = deal.currency?.trim() ?? "";
  if (code === "GBp" || code.toUpperCase() === "GBX") return `${figures}p`;
  if (!code) return figures;
  const sign = CURRENCY_SIGNS[code.toUpperCase()];
  return sign ? `${sign}${figures}` : `${code.toUpperCase()} ${figures}`;
}

/** "$1.2B", "$85M". */
export function formatIpoSize(valueUsd: number | null): string {
  if (valueUsd == null || !Number.isFinite(valueUsd) || valueUsd <= 0) return MISSING;
  return `$${formatCompact(valueUsd)}`;
}

/** A fraction, as the first day's move: 0.164 is "+16.4%". */
export function formatIpoReturn(returnPct: number | null | undefined): string {
  if (returnPct == null || !Number.isFinite(returnPct)) return MISSING;
  const fixed = (returnPct * 100).toFixed(1);
  if (!/[1-9]/.test(fixed)) return "0.0%";
  return `${returnPct > 0 ? "+" : ""}${fixed}%`;
}

const MS_PER_DAY = 86_400_000;

/**
 * "Oct 23" for dates near today, which is nearly every row on a calendar;
 * "Dec 2024" for anything more than half a year off, where the year matters.
 */
export function formatIpoDate(value: string | null, now = new Date()): string {
  if (!value) return MISSING;
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return MISSING;
  const month = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return Math.abs(date.getTime() - now.getTime()) <= 183 * MS_PER_DAY
    ? `${month} ${date.getUTCDate()}`
    : `${month} ${date.getUTCFullYear()}`;
}
