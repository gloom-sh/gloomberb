import type { IpoDeal, IpoRegion, IpoSourceHealth, IpoStatus } from "../../../api-client/ipo";
import type { DataTableColumn } from "../../../components";
import { dropColumnsToFit, getTableWidth } from "../../../components/ui/table-layout";
import { publicTickerKey } from "../../../utils/exchanges";
import { MISSING_VALUE, displayWidth, formatCompact } from "../../../utils/format";
import { compareSortValues, type SortPreference } from "../../../utils/sort-values";
import { rankTickerMatches } from "../../../utils/ticker-match-order";

export const IPO_CALENDAR_PANE_ID = "ipo-calendar";
export const MISSING = MISSING_VALUE;

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
 * pricing or first session reported is `overdue` (late to be reported, or
 * pulled), and `delayed` once DELAYED_AFTER_BUSINESS_DAYS more weekdays have
 * passed: no longer upcoming, kept until its source stops listing it. None of
 * these is a status the server sends.
 */
export type IpoBoardStatus = IpoStatus | "offering" | "overdue" | "delayed";

/** Every word the board shows, in the order a deal moves through them. */
const IPO_BOARD_STATUSES: readonly IpoBoardStatus[] = [
  "filed", "upcoming", "offering", "overdue", "delayed", "priced", "listed", "postponed", "withdrawn",
];

/** Weekdays past its listing date after which a deal not yet priced or trading is delayed. */
const DELAYED_AFTER_BUSINESS_DAYS = 3;

/** `date` plus `days` weekdays, YYYY-MM-DD. */
function addWeekdays(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00Z`);
  for (let left = days; left > 0;) {
    day.setUTCDate(day.getUTCDate() + 1);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) left -= 1;
  }
  return day.toISOString().slice(0, 10);
}

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
      // Intentional ignore: a zone this runtime does not know reads the board at the local date.
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
  if (deal.listingDate) {
    if (deal.listingDate >= today) return "upcoming";
    return addWeekdays(deal.listingDate, DELAYED_AFTER_BUSINESS_DAYS) < today ? "delayed" : "overdue";
  }
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

/** A market the board cannot vouch for, and the day its last read that worked was made (null: none on record). */
export interface MarketBehind {
  market: string;
  since: string | null;
}

/**
 * Markets the board cannot vouch for on this tab: a venue is behind when no
 * source covering it answered, so a failed cross-check alone behind a working
 * exchange feed is not a gap. With `within`, only the markets those deals are
 * on: a search that found US deals says nothing of London's. Each is dated by
 * the latest read of it that worked.
 */
export function marketsBehind(
  sources: readonly IpoSourceHealth[],
  tab: IpoTab,
  deals: readonly IpoDeal[] = [],
  within?: readonly IpoDeal[],
): MarketBehind[] {
  const covered = new Map<string, { ok: boolean; since: string | null }>();
  for (const source of sources) {
    const day = source.asOf && /^\d{4}-\d{2}-\d{2}/.test(source.asOf) ? source.asOf.slice(0, 10) : null;
    for (const mic of source.mics) {
      const known = covered.get(mic);
      const since = [known?.since, day].filter((value): value is string => !!value).sort().at(-1) ?? null;
      covered.set(mic, { ok: (known?.ok ?? false) || source.ok, since });
    }
  }
  const shown = within ? new Set(within.map((deal) => ipoMarketName(deal.mic))) : null;
  const markets: MarketBehind[] = [];
  for (const [mic, { ok, since }] of covered) {
    if (ok) continue;
    const known = MARKETS[mic];
    const region = known?.region ?? deals.find((deal) => deal.mic === mic)?.region ?? "other";
    if (tab !== "all" && region !== tab) continue;
    const market = ipoMarketName(mic);
    if (shown && !shown.has(market)) continue;
    const listed = markets.find((entry) => entry.market === market);
    if (!listed) markets.push({ market, since });
    else if (since && (!listed.since || since > listed.since)) listed.since = since;
  }
  return markets;
}

/** The market a venue answers to: "UK" for XLON; a venue not named yet reads as its MIC. */
function ipoMarketName(mic: string): string {
  return MARKETS[mic]?.market ?? mic;
}

/**
 * "UK not updated since 2026-10-22", "UK not updated since 2026-10-22, India
 * since 2026-11-20", "UK, France and 2 more not updated since 2026-10-22"
 * (the oldest): each market behind with the day it was last read.
 */
export function marketsBehindText(markets: readonly MarketBehind[]): string | null {
  if (markets.length === 0) return null;
  const since = (entry: MarketBehind) => (entry.since ? ` since ${entry.since}` : "");
  if (markets.length > 3) {
    const oldest = markets.map((entry) => entry.since).filter((day): day is string => !!day).sort()[0];
    return `${markets.slice(0, 2).map((entry) => entry.market).join(", ")} and ${markets.length - 2} more not updated${oldest ? ` since ${oldest}` : ""}`;
  }
  const [first, ...rest] = markets;
  return `${first!.market} not updated${since(first!)}${rest.map((entry) => `, ${entry.market}${since(entry) || " not updated"}`).join("")}`;
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
      // Intentional ignore: a region the runtime cannot name leaves the search without a country name.
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

export function filterIpoDeals(deals: readonly IpoDeal[], tab: IpoTab, query = "", now = new Date(), list?: IpoList): IpoDeal[] {
  return deals.filter((deal) => (tab === "all" || deal.region === tab) && (!list || ipoList(deal, now) === list) && matchesIpoQuery(deal, query, now));
}

/**
 * The board's two lists, each with its own columns: the deals not trading
 * yet, with their price range or offer price and size, and the deals that
 * have listed, with their first-day return.
 */
export type IpoList = "upcoming" | "listed";

export const IPO_LISTS: readonly { value: IpoList; label: string }[] = [
  { value: "upcoming", label: "Upcoming" },
  { value: "listed", label: "Recent listings" },
];

export function isIpoList(value: unknown): value is IpoList {
  return value === "upcoming" || value === "listed";
}

/**
 * Which list a deal is on. A listed deal is a recent listing, and so is a
 * priced one whose first session has a price or whose listing day has come at
 * its venue (its first close may not be in yet). Everything else, priced ahead
 * of its day, in its book, filed, postponed or withdrawn, is upcoming: it has
 * no return to show.
 */
export function ipoList(deal: IpoDeal, now = new Date()): IpoList {
  if (deal.status === "listed") return "listed";
  if (deal.status !== "priced") return "upcoming";
  if (deal.firstDay || deal.opening) return "listed";
  return deal.listingDate && deal.listingDate <= venueToday(deal.timezone, now) ? "listed" : "upcoming";
}

export type IpoColumnId = "ticker" | "company" | "market" | "date" | "status" | "price" | "size" | "return" | "lockup";
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
 * The date a deal's row shows: its calendar date, except that a deal priced
 * on a book that has closed, with no listing day named yet, has no date ahead
 * of it. The book's closing day is behind it and says nothing of when it
 * lists, so it shows none rather than a day gone by.
 */
export function ipoShownDate(deal: IpoDeal, now = new Date()): string | null {
  const date = calendarDate(deal);
  if (deal.status !== "priced" || deal.listingDate || deal.firstDay || deal.opening || !date) return date;
  return date < venueToday(deal.timezone, now) ? null : date;
}

/**
 * One date order per list. Upcoming reads soonest first throughout: the deals
 * in their offer now, then the ones dated ahead, set or priced alike, then
 * those with no date ahead (a priced deal waiting for its listing day among
 * them), then the overdue ones, then the filings, then the deals that
 * stopped, a delayed one among them. Recent listings read latest first.
 */
function calendarOrder(boardStatus: (deal: IpoDeal) => IpoBoardStatus, now: Date): (a: IpoDeal, b: IpoDeal) => number {
  const shown = new Map<IpoDeal, string | null>();
  const dateOf = (deal: IpoDeal) => {
    if (!shown.has(deal)) shown.set(deal, ipoShownDate(deal, now));
    return shown.get(deal)!;
  };
  const listed = (deal: IpoDeal) => ipoList(deal, now) === "listed";
  const groupOf = (deal: IpoDeal) => {
    if (listed(deal)) return 1;
    if (boardStatus(deal) === "delayed") return calendarGroup("postponed");
    return deal.status === "priced" ? 0 : calendarGroup(deal.status);
  };
  const rankOf = (deal: IpoDeal) => {
    if (groupOf(deal) !== 0) return 0;
    const status = boardStatus(deal);
    if (status === "offering") return 0;
    if (status === "overdue") return 3;
    return dateOf(deal) === null ? 2 : 1;
  };
  return (a, b) => {
    const group = groupOf(a) - groupOf(b);
    if (group !== 0) return group;
    const rank = rankOf(a) - rankOf(b);
    if (rank !== 0) return rank;
    const date = compareSortValues(dateOf(a), dateOf(b), groupOf(a) === 1 ? "desc" : "asc");
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

function sortValue(columnId: IpoColumnId, deal: IpoDeal, status: IpoBoardStatus, now: Date): string | number | null {
  switch (columnId) {
    case "ticker": return deal.symbol;
    case "company": return deal.company;
    case "market": return deal.venue;
    case "date": return ipoShownDate(deal, now);
    case "status": return IPO_BOARD_STATUSES.indexOf(status);
    case "price": return usdPrice(deal);
    case "size": return deal.offerSizeUsd;
    case "return": return deal.firstDay?.returnPct ?? deal.opening?.returnPct ?? null;
    case "lockup": return deal.lockup?.endsOn ?? null;
  }
}

export function sortIpoDeals(deals: readonly IpoDeal[], sort: IpoSortPreference, now = new Date(), query = ""): IpoDeal[] {
  const { columnId } = sort;
  const statuses = new Map(deals.map((deal) => [deal, ipoBoardStatus(deal, now)]));
  const boardStatus = (deal: IpoDeal) => statuses.get(deal)!;
  const order = calendarOrder(boardStatus, now);
  const sorted = [...deals].sort(!columnId ? order : (a, b) => (
    compareSortValues(sortValue(columnId, a, boardStatus(a), now), sortValue(columnId, b, boardStatus(b), now), sort.direction) || order(a, b)
  ));
  return rankTickerMatches(sorted, query, (deal) => [deal.symbol, deal.company, deal.companyLocal]);
}

/** Names read A to Z first; dates soonest first; numbers largest first. */
export function firstIpoSortDirection(columnId: IpoColumnId): "asc" | "desc" {
  return columnId === "price" || columnId === "size" || columnId === "return" ? "desc" : "asc";
}

const COMPANY_MIN_WIDTH = 16;

/** Every column at its narrowest; COMPANY takes what the pane has left. Each list shows its own (IPO_LIST_COLUMNS). */
const IPO_COLUMNS: readonly IpoColumn[] = [
  // NSE symbols run to ten letters; the rest are far shorter.
  { id: "ticker", label: "TICKER", width: 10, align: "left" },
  { id: "company", label: "COMPANY", width: COMPANY_MIN_WIDTH, align: "left", flexGrow: 1 },
  // Sized to the board's longest venue, see marketColumnWidth.
  { id: "market", label: "MKT", width: 10, align: "left" },
  { id: "date", label: "DATE", width: 8, align: "left" },
  { id: "status", label: "STATUS", width: 9, align: "left" },
  // "HK$26.20-28.50". Each deal says whether it owes one (ipoPriceMayBeBlank).
  { id: "price", label: "PRICE", width: 14, align: "right" },
  // "$218.82M". A deal's size comes with its terms and its return with its first day: an upcoming one has neither.
  { id: "size", label: "SIZE", width: 8, align: "right", mayBeBlank: true },
  // The first day's return from the offer, never one since: the detail says that apart.
  { id: "return", label: "DAY 1", width: 8, align: "right", mayBeBlank: true },
  // A US IPO's estimated lock-up end, "~2 Nov", as `fn IPO` lists it; sized to the board's (ipoDateColumnWidths).
  { id: "lockup", label: "LOCKUP", width: 7, align: "left", mayBeBlank: true },
];

/**
 * The columns each list has. An upcoming deal has no return yet; a recent
 * listing ends on its return. STATUS shows only a status other than the
 * list's own (ipoListStatus), so a deal priced, in its book or late stands out
 * among the upcoming ones, and one priced on its listing day among those listed.
 */
const IPO_LIST_COLUMNS: Record<IpoList, readonly IpoColumnId[]> = {
  upcoming: ["ticker", "company", "market", "date", "status", "price", "size"],
  listed: ["ticker", "company", "market", "date", "status", "price", "size", "return", "lockup"],
};

/** The status every deal on a list has, which its STATUS column leaves blank. */
const IPO_LIST_STATUS: Record<IpoList, IpoBoardStatus> = { upcoming: "upcoming", listed: "listed" };

/** What a deal's STATUS cell says on `list`: its status where it differs from the list's own, else nothing. */
export function ipoListStatus(deal: IpoDeal, list: IpoList | null | undefined, now = new Date()): string {
  const status = ipoBoardStatus(deal, now);
  return list && status === IPO_LIST_STATUS[list] ? "" : status;
}

/**
 * What a narrow pane gives up first, so COMPANY and DAY 1 stay. SIZE is
 * only filled once terms are out, STATUS follows from the calendar's order,
 * the date and a return, the lock-up estimate goes before the price, and MKT
 * before the date a deal lists on.
 */
const NARROW_DROP_ORDER: readonly IpoColumnId[] = ["size", "status", "lockup", "price", "market", "date", "ticker"];

/**
 * Upcoming deals keep COMPANY, the date and the status the longest: what is
 * next, and whether its book is open, priced or late, is the list's point.
 */
const NARROW_DROP_ORDER_BY_LIST: Record<IpoList, readonly IpoColumnId[]> = {
  upcoming: ["size", "market", "price", "ticker", "status", "date"],
  listed: NARROW_DROP_ORDER,
};

/** The table's own width for these columns, plus a cell for the scrollbar. */
export function ipoTableWidth(columns: readonly IpoColumn[]): number {
  return getTableWidth(columns) + 1;
}

/** MKT fits the longest venue on the board ("NYSE American"), and no wider. */
export function marketColumnWidth(deals: readonly IpoDeal[]): number {
  const longest = deals.reduce((max, deal) => Math.max(max, displayWidth(deal.venue || deal.mic)), 0);
  return Math.min(14, Math.max(5, longest));
}

/** DATE and LOCKUP widths that fit every date the board shows (ipoDateColumnWidths); the narrowest by default. */
export interface IpoDateWidths {
  date: number;
  lockup: number;
}

/**
 * DATE and LOCKUP as wide as the longest date on the board, and no wider:
 * "23 Oct" while every date is near, "7 May 2026" once one is half a year off.
 */
export function ipoDateColumnWidths(deals: readonly IpoDeal[], now = new Date()): IpoDateWidths {
  let date = 6;
  let lockup = 7;
  for (const deal of deals) {
    date = Math.max(date, displayWidth(formatIpoDate(ipoShownDate(deal, now), now)));
    if (deal.lockup) lockup = Math.max(lockup, displayWidth(formatIpoLockupDate(deal.lockup.endsOn, now)));
  }
  return { date, lockup };
}

/** The columns of every deal, or of one list's (`list`), that fit `width`. */
export function buildIpoColumns(width: number, marketWidth = 10, list?: IpoList, dates?: IpoDateWidths): IpoColumn[] {
  const columns = IPO_COLUMNS
    .filter((column) => !list || IPO_LIST_COLUMNS[list].includes(column.id))
    .map((column) => (column.id === "market" ? { ...column, width: marketWidth }
      : dates && (column.id === "date" || column.id === "lockup") ? { ...column, width: dates[column.id] } : column));
  return dropColumnsToFit(columns, width - 1, list ? NARROW_DROP_ORDER_BY_LIST[list] : NARROW_DROP_ORDER);
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
const DIRECT_LISTING_PRICE = "direct listing";
const DIRECT_LISTING_NO_PRICE = "direct listing, no offer price";

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

/**
 * Whether a deal's PRICE is blank with no price missing: it has not priced
 * (filed, upcoming, postponed or withdrawn, with no range out yet), or it
 * lists by introduction, which sells no shares.
 *
 * A priced or listed offering owes one. A venue that publishes no offer price
 * sends the same null prices as a deal whose price was lost, so a capture
 * whose every priced deal has none fails on the column.
 */
export function ipoPriceMayBeBlank(deal: Pick<IpoDeal, "status" | "listingType">): boolean {
  return (deal.status !== "priced" && deal.status !== "listed") || deal.listingType === "introduction";
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
 * "23 Oct" for dates near today, which is nearly every row on a calendar;
 * "7 May 2026" for anything more than half a year off, where the year
 * matters. Always the day: a listing or a lock-up is dated to it.
 */
export function formatIpoDate(value: string | null, now = new Date()): string {
  if (!value) return MISSING;
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return MISSING;
  const month = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const day = `${date.getUTCDate()} ${month}`;
  return Math.abs(date.getTime() - now.getTime()) <= 183 * MS_PER_DAY ? day : `${day} ${date.getUTCFullYear()}`;
}

/** "~2026-11-02": when a deal's lock-up is estimated to end; "—" without an estimate. */
export function formatIpoLockupEnd(endsOn: string | null | undefined): string {
  return endsOn ? `~${endsOn}` : MISSING;
}

/** "~2 Nov", as the pane's LOCKUP reads the same estimate (formatIpoDate); the missing mark without one. */
export function formatIpoLockupDate(endsOn: string | null | undefined, now = new Date()): string {
  return endsOn ? `~${formatIpoDate(endsOn, now)}` : MISSING;
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

/**
 * What the estimate counts from, as the server made it. The period is the
 * prospectus's own (`prospectus`) or the typical 180 days; it counts from
 * the prospectus date when one was read, else from the first session:
 * - "180 days from the prospectus dated 2026-05-06"
 * - "90 days from the first session on 2026-05-07, the period the prospectus states"
 * - "the typical 180 days from the prospectus dated 2026-05-06"
 * - "the typical 180 days from the first session on 2026-05-07; the prospectus has not been read"
 */
export function ipoLockupBasis(deal: Pick<IpoDeal, "lockup" | "listingDate">): string | null {
  const lockup = deal.lockup;
  if (!lockup) return null;
  const stated = lockup.basis === "prospectus";
  const from = lockup.prospectusDate
    ? `from the prospectus dated ${lockup.prospectusDate}`
    : `from the first session${deal.listingDate ? ` on ${deal.listingDate}` : ""}`;
  if (stated) return `${lockup.days} days ${from}${lockup.prospectusDate ? "" : ", the period the prospectus states"}`;
  // A prospectus read with no period it states (or none of a lock-up's length) is still read.
  const read = lockup.prospectusDate != null || lockup.prospectusUrl != null;
  return `the typical ${lockup.days} days ${from}${read ? "" : "; the prospectus has not been read"}`;
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
