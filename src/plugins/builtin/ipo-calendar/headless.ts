import type {
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
  HeadlessRowsResult,
} from "../../../types/plugin";
import { formatIpoDate, matchesIpoRecord } from "./client";
import { loadIpoCalendar, type IpoCalendarResult } from "./cache";
import type { IPORecord, IPOStatus } from "./types";

const IPO_COLUMNS = [
  { key: "ticker", header: "Ticker" },
  { key: "company", header: "Company" },
  { key: "date", header: "Date" },
  { key: "status", header: "Status" },
  { key: "exchange", header: "Exchange" },
  { key: "offerSize", header: "Offer", align: "right" as const },
  { key: "priceLow", header: "Price low", align: "right" as const },
  { key: "priceHigh", header: "Price high", align: "right" as const },
  { key: "pricedPrice", header: "Priced", align: "right" as const },
  { key: "shares", header: "Shares", align: "right" as const },
  { key: "closePrice", header: "Close", align: "right" as const },
  { key: "change1D", header: "1D %", align: "right" as const },
];

export interface IpoCalendarHeadlessDependencies {
  loadCalendar(): Promise<IpoCalendarResult>;
}

const defaultDependencies: IpoCalendarHeadlessDependencies = {
  loadCalendar: () => loadIpoCalendar(false),
};

function statusOption(args: HeadlessPaneLoadArgs): IPOStatus | "all" {
  return String(args.options.status ?? "all") as IPOStatus | "all";
}

function toHeadlessRow(record: IPORecord) {
  return {
    ticker: record.ticker,
    company: record.companyName,
    date: formatIpoDate(record.date),
    status: record.status,
    exchange: record.exchange,
    offerSize: record.offerSize,
    priceLow: record.priceRange?.[0] ?? null,
    priceHigh: record.priceRange?.[1] ?? null,
    pricedPrice: record.pricedPrice,
    shares: record.shares,
    closePrice: record.closePrice,
    change1D: record.change1D,
  };
}

export function projectIpoCalendarHeadless(
  result: IpoCalendarResult,
  args: HeadlessPaneLoadArgs,
): HeadlessRowsResult {
  const query = typeof args.argument === "string" ? args.argument.trim() : "";
  const status = statusOption(args);
  const limit = Number(args.options.limit ?? 50);
  const matching = result.records.filter((record) => (
    matchesIpoRecord(record, query)
    && (status === "all" || record.status === status)
  ));
  const rows = matching.slice(0, limit).map(toHeadlessRow);

  return {
    columns: IPO_COLUMNS,
    rows,
    errors: result.errors.length > 0 ? result.errors : undefined,
    metadata: {
      fetchedAt: result.fetchedAt,
      stale: result.stale,
      total: matching.length,
      returned: rows.length,
      truncated: rows.length < matching.length,
      query: query || null,
      status,
    },
  };
}

export function createIpoCalendarHeadless(
  dependencies: IpoCalendarHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    argument: {
      kind: "free-text",
      placeholder: "company or ticker",
      description: "Optional company, ticker, exchange, or status filter.",
      optional: true,
    },
    options: [
      {
        key: "status",
        description: "IPO stage to include.",
        type: "enum",
        values: [
          { value: "all" },
          { value: "upcoming" },
          { value: "priced" },
          { value: "trading" },
        ],
        defaultValue: "all",
      },
      {
        key: "limit",
        description: "Maximum IPO rows to return.",
        type: "integer",
        defaultValue: 50,
        minimum: 1,
        maximum: 200,
      },
    ],
    columns: IPO_COLUMNS,
    describe: (args) => {
      const status = statusOption(args);
      return status === "all" ? "IPO Calendar" : `IPO Calendar | ${status}`;
    },
    async load(args) {
      return projectIpoCalendarHeadless(await dependencies.loadCalendar(), args);
    },
  };
}

export const ipoCalendarHeadless = createIpoCalendarHeadless();
