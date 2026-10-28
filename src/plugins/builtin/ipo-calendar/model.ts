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
 * What the board says a deal is: its status, except for an upcoming deal
 * whose dates have come. One whose book has opened with no listing date named
 * yet is `offering`; one whose listing day has passed at its venue with no
 * pricing or first session reported is `overdue` (pulled, postponed, or late
 * to be reported). Neither is a status the server sends.
 */
export type IpoBoardStatus = IpoStatus | "offering" | "overdue";

/** Every word the board shows, in the order a deal moves through them. */
const IPO_BOARD_STATUSES: readonly IpoBoardStatus[] = [
  "filed", "upcoming", "offering", "overdue", "priced", "listed", "postponed", "withdrawn",
];

const venueDays = new Map<string, Intl.DateTimeFormat | null>();

/** Today where the board is read, YYYY-MM-DD. */
function localToday(now = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Today at a venue, YYYY-MM-DD; where the board is read when the zone is not one this runtime knows. */
function venueToday(timeZone: string, now = new Date()): string {
  let format = venueDays.get(timeZone);
  if (format === undefined) {
    try {
      format = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    } catch {
      format = null;
    }
    venueDays.set(timeZone, format);
  }
  if (!format) return localToday(now);
  const parts = Object.fromEntries(format.formatToParts(now).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function ipoBoardStatus(deal: IpoDeal, now = new Date()): IpoBoardStatus {
  if (deal.status !== "upcoming") return deal.status;
  const today = venueToday(deal.timezone, now);
  if (deal.listingDate) return deal.listingDate < today ? "overdue" : "upcoming";
  const opened = deal.subscriptionOpen ?? deal.subscriptionClose;
  return opened && opened <= today ? "offering" : "upcoming";
}

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

/** What `pending` searches for: a deal not priced yet. */
const NOT_PRICED_STATUSES: readonly IpoStatus[] = ["filed", "upcoming"];

/** The words that name a region, as a tab does; a US deal is already found by its country. */
const REGION_WORDS: Partial<Record<IpoRegion, readonly string[]>> = {
  europe: ["europe"],
  apac: ["apac", "asia", "asia-pacific"],
};

/**
 * Words that name a kind of deal rather than one: `lockup` (`lock-up`,
 * `lock up`, `lockups`) lists the deals with a lock-up estimate, `spac` the
 * SPACs' own IPOs, and `de-spac` (`despac`) those too: a SPAC's merger with
 * its target is no IPO, so the calendar has none of its own.
 */
export type IpoKeyword = "lockup" | "spac" | "de-spac";

export function ipoKeyword(query: string): IpoKeyword | null {
  const word = query.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (/^lockups?$/.test(word)) return "lockup";
  if (/^spacs?$/.test(word)) return "spac";
  if (/^despacs?$/.test(word)) return "de-spac";
  return null;
}

/**
 * Company in either script, symbol, venue, country code or name, and the
 * status the board shows. The word `pending` is no status of its own: it is
 * every deal not priced yet, offering and overdue ones included.
 * A region's name (`europe`, `asia`) lists the region's deals, on whichever tab is open.
 * A kind of deal (`lockup`, `spac`, `de-spac`, see ipoKeyword) lists that kind.
 */
function matchesIpoQuery(deal: IpoDeal, query: string, now: Date): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (needle === "pending") return NOT_PRICED_STATUSES.includes(deal.status);
  const keyword = ipoKeyword(needle);
  if (keyword === "lockup") return !!deal.lockup;
  if (keyword) return deal.listingType === "spac";
  if (REGION_WORDS[deal.region]?.includes(needle.replace(/\s+/g, "-"))) return true;
  return [
    deal.company, deal.companyLocal, deal.symbol, deal.venue, deal.mic, deal.exchange,
    deal.country, countryName(deal.country), deal.segment, ipoBoardStatus(deal, now),
  ].some((value) => !!value && value.toLowerCase().includes(needle));
}

export function filterIpoDeals(deals: readonly IpoDeal[], tab: IpoTab, query = "", now = new Date()): IpoDeal[] {
  return deals.filter((deal) => (tab === "all" || deal.region === tab) && matchesIpoQuery(deal, query, now));
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

/**
 * Upcoming deals: the ones in their offer now, then the ones still ahead
 * soonest first, then undated ones, then the overdue ones most recent first,
 * so the board opens on what is next. Everything after them most recent first.
 */
function calendarOrder(boardStatus: (deal: IpoDeal) => IpoBoardStatus): (a: IpoDeal, b: IpoDeal) => number {
  const upcomingRank = (deal: IpoDeal) => {
    const status = boardStatus(deal);
    if (status === "offering") return 0;
    if (status === "overdue") return 3;
    return calendarDate(deal) === null ? 2 : 1;
  };
  return (a, b) => {
    const group = calendarGroup(a.status) - calendarGroup(b.status);
    if (group !== 0) return group;
    const upcoming = a.status === "upcoming";
    const rank = upcoming ? upcomingRank(a) - upcomingRank(b) : 0;
    if (rank !== 0) return rank;
    const ascending = upcoming && upcomingRank(a) < 3;
    const date = compareSortValues(calendarDate(a), calendarDate(b), ascending ? "asc" : "desc");
    return date || a.company.localeCompare(b.company) || a.id.localeCompare(b.id);
  };
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

function sortValue(columnId: IpoColumnId, deal: IpoDeal, status: IpoBoardStatus): string | number | null {
  switch (columnId) {
    case "ticker": return deal.symbol;
    case "company": return deal.company;
    case "market": return deal.venue;
    case "date": return calendarDate(deal);
    case "status": return IPO_BOARD_STATUSES.indexOf(status);
    case "price": return usdPrice(deal);
    case "size": return deal.offerSizeUsd;
    case "return": return deal.firstDay?.returnPct ?? null;
  }
}

export function sortIpoDeals(deals: readonly IpoDeal[], sort: IpoSortPreference, now = new Date()): IpoDeal[] {
  const { columnId } = sort;
  const statuses = new Map(deals.map((deal) => [deal, ipoBoardStatus(deal, now)]));
  const boardStatus = (deal: IpoDeal) => statuses.get(deal)!;
  const order = calendarOrder(boardStatus);
  if (!columnId) return [...deals].sort(order);
  return [...deals].sort((a, b) => (
    compareSortValues(sortValue(columnId, a, boardStatus(a)), sortValue(columnId, b, boardStatus(b)), sort.direction) || order(a, b)
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

/** What a direct listing with no price reads in a column; a report's row says why in full. */
export const DIRECT_LISTING_PRICE = "direct listing";
export const DIRECT_LISTING_NO_PRICE = "direct listing, no offer price";

/**
 * "$18", "HK$26.20-28.50", "240-260p", "CHF 45": the offer price once set, else the range.
 * A direct listing sells no shares at a price: "direct listing" (`full`: "direct listing, no offer price").
 */
export function formatIpoPrice(deal: IpoDeal, { full = false }: { full?: boolean } = {}): string {
  const low = deal.offerPrice ?? deal.priceLow ?? deal.priceHigh;
  if (low == null && deal.listingType === "direct") return full ? DIRECT_LISTING_NO_PRICE : DIRECT_LISTING_PRICE;
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

/** "~2026-11-02": when a deal's lock-up is estimated to end; "—" without an estimate. */
export function formatIpoLockupEnd(endsOn: string | null | undefined): string {
  return endsOn ? `~${endsOn}` : MISSING;
}

/** Today in UTC, YYYY-MM-DD. */
function utcToday(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * "lockup ends ~2026-11-02 (estimate)", "lockup ended ~2026-07-28 (estimate)":
 * a deal's lock-up estimate in words; null without one.
 */
export function ipoLockupText(deal: Pick<IpoDeal, "lockup">, now = new Date()): string | null {
  if (!deal.lockup) return null;
  const verb = deal.lockup.endsOn < utcToday(now) ? "ended" : "ends";
  return `lockup ${verb} ~${deal.lockup.endsOn} (estimate)`;
}

/** What the estimate counts from: "180 days from the prospectus dated 2026-05-06", or the usual period from the first session. */
export function ipoLockupBasis(deal: Pick<IpoDeal, "lockup" | "listingDate">): string | null {
  const lockup = deal.lockup;
  if (!lockup) return null;
  if (lockup.basis === "prospectus" && lockup.prospectusDate) {
    return `${lockup.days} days from the prospectus dated ${lockup.prospectusDate}`;
  }
  return `the usual ${lockup.days} days from the first session${deal.listingDate ? ` on ${deal.listingDate}` : ""}; the prospectus has not been read`;
}

/** A price in the deal's own currency: "$26", "HK$7.20". */
export function formatIpoAmount(deal: Pick<IpoDeal, "currency">, value: number): string {
  return formatIpoPrice({ offerPrice: value, priceLow: null, priceHigh: null, currency: deal.currency, listingType: "ipo" } as IpoDeal);
}

/**
 * What a listed deal's price has done since it listed: from the offer price,
 * else (a direct listing) from its first trade. Null without a price now or a
 * price to measure from.
 */
export function ipoReturnSince(deal: IpoDeal, price: number | null | undefined): { from: number; basis: "offer" | "first trade"; returnPct: number } | null {
  if (price == null || !Number.isFinite(price) || price <= 0) return null;
  const offer = deal.offerPrice;
  if (offer != null && offer > 0) return { from: offer, basis: "offer", returnPct: price / offer - 1 };
  const open = deal.firstDay?.open;
  if (deal.listingType === "direct" && open != null && open > 0) return { from: open, basis: "first trade", returnPct: price / open - 1 };
  return null;
}

/** The lock-up stories worth listing beside a deal: on or after its listing, about its lock-up. */
const LOCKUP_WORDS = /\block[\s-]?ups?\b/i;

export function isLockupStory(title: string): boolean {
  return LOCKUP_WORDS.test(title);
}
