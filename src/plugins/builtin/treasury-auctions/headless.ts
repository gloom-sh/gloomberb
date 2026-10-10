import type {
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import { formatCompact } from "../../../utils/format";
import { fetchTreasuryAuctions } from "./client";
import { loadTreasuryAuctions, type TreasuryAuctionsResult } from "./cache";
import type { TreasuryAuction } from "./types";
import {
  AUCTION_HISTORY_WINDOWS,
  AUCTION_SEARCH_FIELDS,
  auctionHistoryLabel,
  auctionHistoryPhrase,
  auctionSize,
  dealerPct,
  DEFAULT_AUCTION_SORT,
  directPct,
  formatAuctionRate,
  indirectPct,
  nextAuctionHistoryWindow,
  rateValue,
  stopOutVsAverageBp,
  visibleAuctions,
  type AuctionFilter,
} from "./model";

const formatPercent = (value: unknown) => value == null ? "-" : `${Number(value).toFixed(1)}%`;

/** Why the stop-out column is not a tail; the docs page says the same at length. */
const STOP_OUT_NOTE = "Stop-out vs avg is the high yield minus the average/median yield, in bp (bills: discount rates). "
  + "A true tail, the stop-out against the 1 pm when-issued yield, needs the when-issued yield, which the source does not carry.";

const COLUMNS = [
  { key: "auctionDate", header: "Date" },
  { key: "secType", header: "Type" },
  { key: "securityTerm", header: "Term" },
  { key: "rate", header: "Rate", align: "right" as const, format: (value: unknown, row: Record<string, unknown>) => formatAuctionRate(row as unknown as TreasuryAuction, value == null ? null : Number(value), "-") },
  { key: "stopOutVsAvgBp", header: "Stop-out vs avg (bp)", align: "right" as const, format: (value: unknown) => value == null ? "-" : Number(value).toFixed(1) },
  { key: "bidToCoverRatio", header: "B/C", align: "right" as const, format: (value: unknown) => value == null ? "-" : Number(value).toFixed(2) },
  { key: "indirectPercent", header: "Indirect", align: "right" as const, format: formatPercent },
  { key: "directPercent", header: "Direct", align: "right" as const, format: formatPercent },
  { key: "dealerPercent", header: "Dealer", align: "right" as const, format: formatPercent },
  { key: "size", header: "Size", align: "right" as const, format: (value: unknown) => value == null ? "-" : `$${formatCompact(Number(value))}` },
  { key: "cusip", header: "CUSIP" },
];

interface TreasuryAuctionsHeadlessDependencies {
  load(args: HeadlessPaneLoadArgs, historyDays: number): Promise<TreasuryAuctionsResult>;
}

const defaultDependencies: TreasuryAuctionsHeadlessDependencies = {
  load: (_args, historyDays) => loadTreasuryAuctions(false, fetchTreasuryAuctions, historyDays),
};

/** An empty table says what was searched, in which window, and what the search understands. */
function emptyNote(query: string, filter: AuctionFilter, historyDays: number): string {
  const searched = query.trim() ? `match "${query.trim()}"` : "found";
  const group = filter === "all" ? "" : ` in the ${filter} group`;
  return `No auctions ${searched}${group} in ${auctionHistoryPhrase(historyDays)}. Search by ${AUCTION_SEARCH_FIELDS}.`;
}

function createTreasuryAuctionsHeadless(
  dependencies: TreasuryAuctionsHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    freshness: { source: "US Treasury", status: "not-a-feed", basis: "auction results", observedKey: "auctionDate", oldest: null, tradingDayMarket: "US" },
    argument: {
      kind: "free-text",
      placeholder: "search",
      description: "Optional search: security type, benchmark (10Y), term, CUSIP, or auction date (YYYY-MM-DD).",
      optional: true,
    },
    options: [
      {
        key: "historyDays",
        aliases: ["history"],
        settingKey: "historyDays",
        description: "Auction history window in days, up to 3650 (10 years).",
        type: "enum",
        values: AUCTION_HISTORY_WINDOWS.map((days) => ({ value: String(days) })),
        defaultValue: "120",
      },
      {
        key: "filter",
        description: "Security type group.",
        type: "enum",
        values: [{ value: "all" }, { value: "bill" }, { value: "note" }, { value: "bond" }],
        defaultValue: "all",
      },
    ],
    columns: COLUMNS,
    describe: (args) => `Treasury Auctions | ${String(args.options.historyDays)} days | ${String(args.options.filter)}`,
    async load(args) {
      const historyDays = Number(args.options.historyDays);
      const filter = args.options.filter as AuctionFilter;
      const result = await dependencies.load(args, historyDays);
      const query = typeof args.argument === "string" ? args.argument : "";
      const auctions = visibleAuctions(result.auctions, {
        filter,
        query,
        sort: DEFAULT_AUCTION_SORT,
      });
      const nextWindow = nextAuctionHistoryWindow(historyDays);
      const notes = [
        ...(auctions.length === 0 ? [emptyNote(query, filter, historyDays)] : []),
        nextWindow
          ? `Older auctions: use --historyDays ${nextWindow}.`
          : `Auctions older than ${auctionHistoryLabel(historyDays)} are not loaded.`,
        ...(auctions.length > 0 ? [STOP_OUT_NOTE] : []),
      ];
      return {
        complete: !result.refreshError,
        errors: result.refreshError ? [result.refreshError] : [],
        notes,
        rows: auctions.map((auction) => ({
          ...auction,
          rate: rateValue(auction),
          stopOutVsAvgBp: stopOutVsAverageBp(auction),
          indirectPercent: indirectPct(auction),
          directPercent: directPct(auction),
          dealerPercent: dealerPct(auction),
          size: auctionSize(auction),
        })),
        metadata: {
          fetchedAt: result.fetchedAt,
          stale: result.stale,
          historyDays,
          filter,
        },
      };
    },
  };
}

export const treasuryAuctionsHeadless = createTreasuryAuctionsHeadless();
