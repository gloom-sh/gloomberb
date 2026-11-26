import type { IpoCalendarPayload, IpoDeal, IpoStatus } from "../../../api-client/ipo";
import type {
  HeadlessPaneColumn,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
  HeadlessRowsResult,
} from "../../../types/plugin";
import { fetchIpoCalendar } from "./client";
import {
  filterIpoDeals,
  formatIpoLockupEnd,
  formatIpoPrice,
  formatIpoReturn,
  formatIpoSize,
  IPO_STATUSES,
  ipoBoardStatus,
  ipoKeyword,
  ipoListStatus,
  ipoShownDate,
  isIpoList,
  isIpoTab,
  marketsBehind,
  marketsBehindText,
  sortIpoDeals,
  DEFAULT_IPO_SORT,
  type IpoList,
  type IpoTab,
} from "./model";
import { ipoDetailSentences, ipoPriceNow, loadIpoLockupNews, type IpoLockupStory, type IpoPriceNow } from "./listing-ipo";
import { REPORT_FILTER, REPORT_ROWS } from "../shared/headless-options";
import { DATE_OPTION_EXAMPLES, isoDateOption } from "../../../utils/calendar-date";
import { logFailure } from "../../../utils/log-failure";

const COLUMNS: HeadlessPaneColumn[] = [
  { key: "ticker", header: "Ticker" },
  { key: "company", header: "Company" },
  { key: "venue", header: "Market" },
  // The pane's DATE: the listing date, else the book's while it has none.
  { key: "date", header: "Date" },
  { key: "status", header: "Status" },
  { key: "price", header: "Price", align: "right" },
  { key: "offerSizeUsd", header: "Size", align: "right", format: (value) => formatIpoSize(value as number | null) },
  { key: "firstDayReturn", header: "Day 1", align: "right", format: (value, row) => formatIpoReturn((value ?? row.openingReturn) as number | null),
    textFormat: (value, row) => value == null && row.openingReturn != null ? `${formatIpoReturn(row.openingReturn as number)} open` : formatIpoReturn(value as number | null) },
  // A US IPO's estimated lock-up end: "~2026-11-02".
  { key: "lockupEnds", header: "Lockup ends", format: (value) => formatIpoLockupEnd(typeof value === "string" ? value : null) },
];

/** A stage the server sends, or `delayed`: the upcoming deals past their date, which `upcoming` leaves out. */
type StatusOption = IpoStatus | "delayed" | "all";
const STATUS_OPTIONS: readonly string[] = [...IPO_STATUSES, "delayed"];

/** Whether a deal is at the stage asked for, as the board reads it. */
function atStatus(deal: IpoDeal, status: StatusOption, now: Date): boolean {
  if (status === "all") return true;
  const shown = ipoBoardStatus(deal, now);
  if (status === "delayed") return shown === "delayed";
  return deal.status === status && shown !== "delayed";
}

function regionOption(args: HeadlessPaneLoadArgs): IpoTab {
  const value = args.options.region;
  return isIpoTab(value) ? value : "all";
}

/** The pane's list, when one is asked for; without it the report lists every deal. */
function listOption(args: HeadlessPaneLoadArgs): IpoList | null {
  const value = args.options.list;
  return isIpoList(value) ? value : null;
}

/**
 * One list's columns, as its pane view has them: an upcoming deal has no
 * return or lock-up yet. Status reads only where it differs from the list's
 * own (a priced deal among the upcoming ones), and goes when none does;
 * the rows keep every status.
 */
function listColumns(list: IpoList | null, deals: readonly IpoDeal[], now: Date): HeadlessPaneColumn[] {
  if (!list) return COLUMNS;
  const quiet = deals.every((deal) => ipoListStatus(deal, list, now) === "");
  return COLUMNS.flatMap((column) => {
    if (list === "upcoming" && (column.key === "firstDayReturn" || column.key === "lockupEnds")) return [];
    if (column.key !== "status") return [column];
    return quiet ? [] : [{ ...column, textFormat: (value: unknown) => (value === (list === "upcoming" ? "upcoming" : "listed") ? "" : String(value ?? "")) }];
  });
}

function statusOption(args: HeadlessPaneLoadArgs): StatusOption {
  const value = String(args.options.status ?? "all");
  return STATUS_OPTIONS.includes(value) ? value as StatusOption : "all";
}

function toRow(deal: IpoDeal, now: Date) {
  return {
    id: deal.id,
    ticker: deal.symbol,
    exchange: deal.exchange,
    mic: deal.mic,
    company: deal.company,
    companyLocal: deal.companyLocal,
    venue: deal.venue,
    segment: deal.segment,
    country: deal.country,
    region: deal.region,
    // As the pane's DATE: none for a priced deal whose book closed with no listing day named.
    date: ipoShownDate(deal, now),
    listingDate: deal.listingDate,
    dateKind: deal.dateKind,
    subscriptionOpen: deal.subscriptionOpen,
    subscriptionClose: deal.subscriptionClose,
    // As the pane reads it: an upcoming deal may be offering, overdue or delayed.
    status: ipoBoardStatus(deal, now),
    listingType: deal.listingType,
    currency: deal.currency,
    price: formatIpoPrice(deal, { full: true }),
    priceLow: deal.priceLow,
    priceHigh: deal.priceHigh,
    offerPrice: deal.offerPrice,
    sharesOffered: deal.sharesOffered,
    offerSize: deal.offerSize,
    offerSizeUsd: deal.offerSizeUsd,
    firstDayClose: deal.firstDay?.close ?? null,
    firstDayReturn: deal.firstDay?.returnPct ?? null,
    openingPrice: deal.opening?.price ?? null,
    openingReturn: deal.opening?.returnPct ?? null,
    filedDate: deal.filedDate,
    lockupEnds: deal.lockup?.endsOn ?? null,
    lockupBasis: deal.lockup?.basis ?? null,
    prospectusDate: deal.lockup?.prospectusDate ?? null,
  };
}

/** One deal found: its IPO in words, as `ticker` gives it, with its price as `quote` reads it and its lock-up news. */
interface IpoDealDetail {
  price: IpoPriceNow | null;
  news: IpoLockupStory[];
}

/** Lock-up estimates soonest first, then the ones that have ended, latest first. */
function byLockupEnd(deals: readonly IpoDeal[], now: Date): IpoDeal[] {
  const today = now.toISOString().slice(0, 10);
  const rank = (deal: IpoDeal) => (deal.lockup!.endsOn >= today ? 0 : 1);
  return [...deals].sort((a, b) => rank(a) - rank(b)
    || (rank(a) === 0 ? a.lockup!.endsOn.localeCompare(b.lockup!.endsOn) : b.lockup!.endsOn.localeCompare(a.lockup!.endsOn))
    || a.id.localeCompare(b.id));
}

/** The most rows `--limit` lists. */
const MAX_ROWS = 500;

const SPAC_NOTE = "A SPAC's merger with its target (de-SPAC) is no IPO, so the calendar lists the SPACs' own IPOs.";

export function projectIpoCalendarHeadless(
  payload: IpoCalendarPayload,
  args: HeadlessPaneLoadArgs,
  detail: IpoDealDetail | null = null,
  now = new Date(),
): HeadlessRowsResult {
  const query = typeof args.argument === "string" ? args.argument.trim() : "";
  const region = regionOption(args);
  const status = statusOption(args);
  const list = listOption(args);
  const limit = Number(args.options.limit ?? 50);
  const keyword = ipoKeyword(query);
  const found = filterIpoDeals(payload.deals, region, query, now, list ?? undefined).filter((deal) => atStatus(deal, status, now));
  const matching = keyword === "lockup" ? byLockupEnd(found, now) : sortIpoDeals(found, DEFAULT_IPO_SORT, now, query);
  const rows = matching.slice(0, limit).map((deal) => toRow(deal, now));
  // A search that found deals speaks for their markets alone: HAWK's report says nothing of London's.
  const behind = marketsBehindText(marketsBehind(payload.sources, region, payload.deals, query && matching.length ? matching : undefined));
  const single = matching.length === 1 && query && !keyword ? matching[0]! : null;
  const notes = [
    ...rows.length < matching.length
      ? [`Showing ${rows.length} of ${matching.length} deals; --limit ${Math.min(matching.length, MAX_ROWS)} lists ${matching.length <= MAX_ROWS ? "them all" : "more"}.`]
      : [],
    ...single ? ipoDetailSentences(single, detail?.price ?? null, detail?.news ?? [], now) : [],
    ...keyword === "spac" || keyword === "de-spac" ? [SPAC_NOTE] : [],
  ];
  return {
    columns: listColumns(list, matching.slice(0, limit), now),
    rows,
    ...(behind ? { errors: [behind] } : {}),
    ...(notes.length ? { notes } : {}),
    metadata: {
      asOf: payload.asOf,
      total: matching.length,
      returned: rows.length,
      truncated: rows.length < matching.length,
      query: query || null,
      region,
      status,
      list,
    },
  };
}

export const ipoCalendarHeadless: HeadlessPaneDefinition<"rows"> = {
  shape: "rows",
  freshness: { source: "Exchange listings", status: "not-a-feed", basis: "calendar" },
  argument: {
    kind: "free-text",
    placeholder: "company or ticker",
    description: "Optional company, ticker, market, country, region or status filter; pending lists the deals not priced yet, lockup the US lock-up expiries soonest first, spac the SPACs' IPOs.",
    optional: true,
  },
  discovery: {
    // The kinds of deal a search lists (ipoKeyword): `fn lockup` is the lock-up expiry list, `catalog spac` finds it.
    opens: [
      { words: ["lockup", "lockups", "lock-up", "lock-ups", "lockup expiry", "lock-up expiry", "lockup expiration", "lock-up expiration"], argument: "lockup" },
      { words: ["spac", "spacs", "de-spac", "despac"], argument: "spac" },
    ],
    dataRequirements: ["Gloom Cloud IPO calendar, merged from each exchange's own listings"],
    limitations: ["Return from the offer price uses the first trade until the first session's close is available."],
  },
  options: [
    {
      key: "region",
      description: "Region of the listing venue.",
      type: "enum",
      defaultValue: "all",
      values: ["all", "us", "apac", "europe"].map((value) => ({ value })),
      // The pane's tab, so a screenshot shows the region the report lists.
      pluginState: { pluginId: "ipo-calendar", key: "region" },
    },
    {
      key: "list",
      description: "Upcoming deals or recent listings, each with the columns its pane view shows; every deal when omitted.",
      type: "enum",
      values: [{ value: "upcoming" }, { value: "listed", aliases: ["recent"] }],
      // The pane's list, so a screenshot shows the deals the report lists.
      pluginState: { pluginId: "ipo-calendar", key: "list" },
    },
    {
      key: "status",
      shot: REPORT_FILTER,
      description: "IPO stage to include; upcoming takes in the deals listed as offering or overdue, and delayed the ones still not listed 3 weekdays past their date.",
      type: "enum",
      defaultValue: "all",
      // `trading` was the plugin's word for a deal that has listed.
      values: ["all", ...STATUS_OPTIONS].map((value) => (value === "listed" ? { value, aliases: ["trading"] } : { value })),
    },
    {
      key: "limit",
      shot: REPORT_ROWS,
      description: "Maximum IPO rows to return.",
      type: "integer",
      defaultValue: 50,
      minimum: 1,
      maximum: MAX_ROWS,
    },
    {
      key: "from",
      type: "string",
      placeholder: "date",
      description: `First listing date, as ${DATE_OPTION_EXAMPLES}; the calendar keeps a year of listings.`,
      example: "--from 2025-11-01",
      normalize: (value) => isoDateOption(value, "from"),
    },
  ],
  columns: COLUMNS,
  describe: (args) => {
    const parts = ["IPO Calendar"];
    const region = regionOption(args);
    const status = statusOption(args);
    if (region !== "all") parts.push(region === "us" ? "US" : region === "apac" ? "APAC" : "Europe");
    const list = listOption(args);
    if (list) parts.push(list === "upcoming" ? "Upcoming" : "Recent listings");
    if (status !== "all") parts.push(status);
    return parts.join(" | ");
  },
  async load(args, ctx) {
    // The default window has no filed or withdrawn deals, so a stage is asked for by name.
    const status = statusOption(args);
    const from = typeof args.options.from === "string" && args.options.from ? args.options.from : undefined;
    // A delayed deal is one the server still calls upcoming.
    const params = { ...(status === "all" ? {} : { status: status === "delayed" ? "upcoming" as const : status }), ...(from ? { from } : {}) };
    const payload = await fetchIpoCalendar(ctx.apiClient, ctx.signal, params);
    const projected = projectIpoCalendarHeadless(payload, args);
    // One deal found: its price now and its lock-up news, which never fail the report.
    const query = typeof args.argument === "string" ? args.argument.trim() : "";
    const matched = projected.rows.length === 1 && query && !ipoKeyword(query)
      ? payload.deals.find((deal) => deal.id === projected.rows[0]!.id) : undefined;
    if (!matched?.symbol) return projected;
    const [price, news] = await Promise.all([
      matched.status === "listed"
        ? ctx.marketData.getQuote(matched.symbol, matched.exchange ?? undefined).then(ipoPriceNow,
          logFailure("plugins.ipo-calendar", "Load the price of an IPO failed", null))
        : Promise.resolve(null),
      loadIpoLockupNews(ctx.apiClient, matched).catch(logFailure("plugins.ipo-calendar", "Load an IPO's lock-up news failed", [] as IpoLockupStory[])),
    ]);
    return projectIpoCalendarHeadless(payload, args, { price, news });
  },
};
