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
  formatIpoPrice,
  formatIpoReturn,
  formatIpoSize,
  IPO_STATUSES,
  isIpoTab,
  marketsBehind,
  marketsBehindText,
  sortIpoDeals,
  DEFAULT_IPO_SORT,
  type IpoTab,
} from "./model";

const COLUMNS: HeadlessPaneColumn[] = [
  { key: "ticker", header: "Ticker" },
  { key: "company", header: "Company" },
  { key: "venue", header: "Market" },
  { key: "listingDate", header: "Date" },
  { key: "status", header: "Status" },
  { key: "price", header: "Price", align: "right" },
  { key: "offerSizeUsd", header: "Size", align: "right", format: (value) => formatIpoSize(value as number | null) },
  { key: "firstDayReturn", header: "Return", align: "right", format: (value) => formatIpoReturn(value as number | null) },
];

type StatusOption = IpoStatus | "all";

function regionOption(args: HeadlessPaneLoadArgs): IpoTab {
  const value = args.options.region;
  return isIpoTab(value) ? value : "all";
}

function statusOption(args: HeadlessPaneLoadArgs): StatusOption {
  const value = String(args.options.status ?? "all");
  return (IPO_STATUSES as readonly string[]).includes(value) ? value as IpoStatus : "all";
}

function toRow(deal: IpoDeal) {
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
    listingDate: deal.listingDate,
    dateKind: deal.dateKind,
    subscriptionOpen: deal.subscriptionOpen,
    subscriptionClose: deal.subscriptionClose,
    status: deal.status,
    listingType: deal.listingType,
    currency: deal.currency,
    price: formatIpoPrice(deal),
    priceLow: deal.priceLow,
    priceHigh: deal.priceHigh,
    offerPrice: deal.offerPrice,
    sharesOffered: deal.sharesOffered,
    offerSize: deal.offerSize,
    offerSizeUsd: deal.offerSizeUsd,
    firstDayClose: deal.firstDay?.close ?? null,
    firstDayReturn: deal.firstDay?.returnPct ?? null,
    filedDate: deal.filedDate,
  };
}

function projectIpoCalendarHeadless(payload: IpoCalendarPayload, args: HeadlessPaneLoadArgs): HeadlessRowsResult {
  const query = typeof args.argument === "string" ? args.argument.trim() : "";
  const region = regionOption(args);
  const status = statusOption(args);
  const limit = Number(args.options.limit ?? 50);
  const matching = sortIpoDeals(
    filterIpoDeals(payload.deals, region, query).filter((deal) => status === "all" || deal.status === status),
    DEFAULT_IPO_SORT,
  );
  const rows = matching.slice(0, limit).map(toRow);
  const behind = marketsBehindText(marketsBehind(payload.sources, region, payload.deals));
  return {
    columns: COLUMNS,
    rows,
    ...(behind ? { errors: [behind] } : {}),
    metadata: {
      asOf: payload.asOf,
      total: matching.length,
      returned: rows.length,
      truncated: rows.length < matching.length,
      query: query || null,
      region,
      status,
    },
  };
}

export const ipoCalendarHeadless: HeadlessPaneDefinition<"rows"> = {
  shape: "rows",
  freshness: { source: "Exchange listings", status: "not-a-feed", basis: "calendar" },
  argument: {
    kind: "free-text",
    placeholder: "company or ticker",
    description: "Optional company, ticker, market, country or status filter.",
    optional: true,
  },
  discovery: {
    dataRequirements: ["Gloom Cloud IPO calendar, merged from each exchange's own listings"],
    limitations: ["First-day return needs an offer price and the first session's close"],
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
      key: "status",
      description: "IPO stage to include.",
      type: "enum",
      defaultValue: "all",
      // `trading` was the plugin's word for a deal that has listed.
      values: ["all", ...IPO_STATUSES].map((value) => (value === "listed" ? { value, aliases: ["trading"] } : { value })),
    },
    {
      key: "limit",
      description: "Maximum IPO rows to return.",
      type: "integer",
      defaultValue: 50,
      minimum: 1,
      maximum: 500,
    },
  ],
  columns: COLUMNS,
  describe: (args) => {
    const parts = ["IPO Calendar"];
    const region = regionOption(args);
    const status = statusOption(args);
    if (region !== "all") parts.push(region === "us" ? "US" : region === "apac" ? "APAC" : "Europe");
    if (status !== "all") parts.push(status);
    return parts.join(" | ");
  },
  async load(args, ctx) {
    // The default window has no filed or withdrawn deals, so a stage is asked for by name.
    const status = statusOption(args);
    const params = status === "all" ? {} : { status };
    return projectIpoCalendarHeadless(await fetchIpoCalendar(ctx.apiClient, ctx.signal, params), args);
  },
};
