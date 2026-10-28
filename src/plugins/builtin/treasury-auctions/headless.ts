import type {
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import { formatCompact } from "../../../utils/format";
import { AUCTION_HISTORY_ALL, AUCTION_HISTORY_START, fetchTreasuryAuctions, type AuctionHistoryWindow } from "./client";
import { loadTreasuryAuctions, type TreasuryAuctionsResult } from "./cache";
import type { TreasuryAuction } from "./types";
import { FIXED_INCOME_VIEW_STATE } from "../fixed-income/model";
import {
  AUCTION_HISTORY_WINDOWS,
  AUCTION_SEARCH_FIELDS,
  auctionHistoryPhrase,
  auctionHistoryWindow,
  auctionSize,
  dealerPct,
  DEFAULT_AUCTION_SORT,
  directPct,
  formatAuctionRate,
  indirectPct,
  isPendingAuction,
  nextAuctionHistoryWindow,
  rateQualifier,
  rateValue,
  stopOutVsAverageBp,
  visibleAuctions,
  type AuctionFilter,
} from "./model";

/**
 * A missing bid-to-cover or bidder split is a blank cell: the source has
 * bid-to-cover regularly from late 1999 and the split only from 2008-04-07,
 * and an announced auction has no results to fill them; its Rate says so.
 */
const formatPercent = (value: unknown) => value == null ? "" : `${Number(value).toFixed(1)}%`;

/** What an announced auction's Rate reads until the source publishes its results. */
const RESULTS_NOT_PUBLISHED = "results not published";
const pending = (row: Record<string, unknown>) => isPendingAuction(row as unknown as TreasuryAuction);

/** Why the stop-out column is not a tail; the docs page says the same at length. */
const STOP_OUT_NOTE = "Stop-out vs avg is the high yield minus the average/median yield, in bp (bills: discount rates). "
  + "A true tail, the stop-out against the 1 pm when-issued yield, needs the when-issued yield, which the source does not carry.";

const MISSING_METRICS_NOTE = "A blank B/C or bidder share is one the source does not have for that auction: "
  + "bid-to-cover is regular from late 1999, the indirect, direct and dealer split from 2008-04-07.";

/** A completed auction the source gives no bid-to-cover or no bidder split for. */
const lacksMetrics = (auction: TreasuryAuction) => !isPendingAuction(auction)
  && (auction.bidToCoverRatio == null || indirectPct(auction) == null || directPct(auction) == null || dealerPct(auction) == null);

/**
 * The rate as the table prints it; a TIPS or FRN row says what its number is
 * (`2.653% real`, `4.0bp spread`), and an announced auction that its results
 * are not published yet.
 */
const rateCell = (value: unknown, row: Record<string, unknown>) => {
  const text = formatAuctionRate(row as unknown as TreasuryAuction, value == null ? null : Number(value), pending(row) ? RESULTS_NOT_PUBLISHED : "-");
  const qualifier = value == null ? null : rateQualifier(row as unknown as TreasuryAuction);
  return qualifier ? `${text} ${qualifier}` : text;
};

const COLUMNS = [
  { key: "auctionDate", header: "Date" },
  { key: "secType", header: "Type" },
  { key: "securityTerm", header: "Term" },
  {
    key: "rate",
    header: "Rate",
    align: "right" as const,
    format: (value: unknown, row: Record<string, unknown>) => formatAuctionRate(
      row as unknown as TreasuryAuction, value == null ? null : Number(value), pending(row) ? RESULTS_NOT_PUBLISHED : "-",
    ),
    textFormat: rateCell,
  },
  {
    key: "stopOutVsAvgBp", header: "Stop-out vs avg (bp)", align: "right" as const,
    format: (value: unknown, row: Record<string, unknown>) => value == null ? pending(row) ? "" : "-" : Number(value).toFixed(1),
  },
  { key: "bidToCoverRatio", header: "B/C", align: "right" as const, format: (value: unknown) => value == null ? "" : Number(value).toFixed(2) },
  { key: "indirectPercent", header: "Indirect", align: "right" as const, format: formatPercent },
  { key: "directPercent", header: "Direct", align: "right" as const, format: formatPercent },
  { key: "dealerPercent", header: "Dealer", align: "right" as const, format: formatPercent },
  { key: "size", header: "Size", align: "right" as const, format: (value: unknown) => value == null ? "-" : `$${formatCompact(Number(value))}` },
  { key: "cusip", header: "CUSIP" },
];

interface TreasuryAuctionsHeadlessDependencies {
  load(args: HeadlessPaneLoadArgs, window: AuctionHistoryWindow): Promise<TreasuryAuctionsResult>;
}

const defaultDependencies: TreasuryAuctionsHeadlessDependencies = {
  load: (_args, window) => loadTreasuryAuctions(false, fetchTreasuryAuctions, window),
};

/** An empty table says what was searched, in which window, and what the search understands. */
function emptyNote(query: string, filter: AuctionFilter, historyDays: AuctionHistoryWindow): string {
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
        description: `Auction history window in days, up to 3650 (10 years), or all: every auction since ${AUCTION_HISTORY_START}.`,
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
        pluginState: { pluginId: FIXED_INCOME_VIEW_STATE.treasuryAuctions, key: "activeTab" },
      },
    ],
    columns: COLUMNS,
    describe: (args) => {
      const window = auctionHistoryWindow({ historyDays: args.options.historyDays });
      return `Treasury Auctions | ${window === AUCTION_HISTORY_ALL ? "all" : `${window} days`} | ${String(args.options.filter)}`;
    },
    async load(args) {
      const historyDays = auctionHistoryWindow({ historyDays: args.options.historyDays });
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
        // ALL is the whole history: nothing older to point to.
        ...(nextWindow ? [`Older auctions: use --historyDays ${nextWindow}.`] : []),
        ...(auctions.length > 0 ? [STOP_OUT_NOTE] : []),
        ...(auctions.some(lacksMetrics) ? [MISSING_METRICS_NOTE] : []),
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
