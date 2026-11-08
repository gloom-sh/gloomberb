import type {
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import type { HeadlessPaneColumn } from "../../../types/headless";
import {
  afterLoadWindow, afterWindowStart, AUCTION_VIEWS, loadAuctionCurves, projectAuctionAfter, widerAfterWindow, type AuctionCurveRead, type AuctionView,
} from "./after";
import { formatCompact } from "../../../utils/format";
import { AUCTION_HISTORY_ALL, AUCTION_HISTORY_START, fetchTreasuryAuctions, type AuctionHistoryWindow } from "./client";
import { loadTreasuryAuctions, type TreasuryAuctionsResult } from "./cache";
import { unansweredRefreshError } from "../../../data/saved-copies";
import type { TreasuryAuction } from "./types";
import { AUCTION_MARKETS, auctionSearchMarket, isAuctionMarket, loadHkTenders, type HkTendersResult } from "./hk";
import { hkTendersReport } from "./hk-headless";
import { FIXED_INCOME_VIEW_STATE } from "../fixed-income/model";
import {
  AUCTION_HISTORY_WINDOWS,
  AUCTION_SEARCH_FIELDS,
  AUCTION_SORT_NAMES,
  auctionHistoryPhrase,
  auctionHistoryWindow,
  auctionSize,
  auctionSortColumn,
  dealerPct,
  DEFAULT_AUCTION_SORT,
  directPct,
  firstAuctionSortDirection,
  formatAuctionRate,
  indirectPct,
  isAfterColumn,
  isBill,
  isPendingAuction,
  namesOtherMarket,
  nextAuctionHistoryWindow,
  rateColumnLabel,
  rateQualifier,
  rateValue,
  stopOutColumnLabel,
  stopOutVsAvgBp,
  visibleAuctions,
  widerWindowCouldAdd,
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
const STOP_OUT_NOTE = "Stop-out vs median is the high yield minus the median yield, in bp (bills: discount rates); "
  + "before November 1998, when most auctions were multiple-price, Treasury published the average, so older rows read against the average. "
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

const LEAD_COLUMNS: HeadlessPaneColumn[] = [
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
];

/** A bill's high discount rate, beside the investment rate its Rate is: the rate Treasury's announcement leads with. */
const DISCOUNT_RATE_COLUMN: HeadlessPaneColumn = {
  key: "highDiscountRate", header: "Discount rate", align: "right" as const,
  format: (value: unknown, row: Record<string, unknown>) => value == null ? pending(row) ? "" : "-" : `${Number(value).toFixed(3)}%`,
};

const RESULT_COLUMNS: HeadlessPaneColumn[] = [
  {
    // Exports keep the name scripts read it by: the spread against the published average, or the median from November 1998.
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

const percentile = (value: unknown) => value == null ? "" : String(value);
const bpMove = (value: unknown) => value == null ? "" : `${Number(value) > 0 ? "+" : ""}${Number(value).toFixed(0)}`;

/** The after view: each auction against its tenor's last 24, and the matching Treasury yield's moves after it. */
const AFTER_COLUMNS: HeadlessPaneColumn[] = [
  { key: "bidToCoverRatio", header: "B/C", align: "right" as const, format: (value: unknown) => value == null ? "" : Number(value).toFixed(2) },
  { key: "btcPercentile", header: "B/C pctl", align: "right" as const, format: percentile },
  { key: "indirectPercentile", header: "Indirect pctl", align: "right" as const, format: percentile },
  { key: "dealerPercentile", header: "Dealer pctl", align: "right" as const, format: percentile },
  { key: "cmt", header: "Yield", description: "The Treasury par yield the moves are read on: the auction's tenor, real for a TIPS." },
  { key: "after1d", header: "+1d (bp)", align: "right" as const, format: bpMove },
  { key: "after5d", header: "+5d (bp)", align: "right" as const, format: bpMove },
  { key: "after20d", header: "+20d (bp)", align: "right" as const, format: bpMove },
  { key: "cusip", header: "CUSIP" },
];

/** The columns a board lists: a bill board heads its rate as the investment rate and puts the discount rate beside it. */
function columnsFor(view: AuctionView, auctions: readonly TreasuryAuction[]): HeadlessPaneColumn[] {
  const rate = { ...LEAD_COLUMNS[3]!, textHeader: rateColumnLabel(auctions, "report") };
  const discount = auctions.some(isBill) ? [DISCOUNT_RATE_COLUMN] : [];
  // The spread is against the median from November 1998 and the average before: the heading says which the rows hold.
  const results = RESULT_COLUMNS.map((column) => column.key === "stopOutVsAvgBp" ? { ...column, textHeader: stopOutColumnLabel(auctions, "report") } : column);
  return [...LEAD_COLUMNS.slice(0, 3), rate, ...discount, ...view === "after" ? AFTER_COLUMNS : results];
}

const AFTER_NOTE = "Percentiles rank each auction against its tenor's previous 24 (at least 12); the moves are the Treasury par yield "
  + "of its tenor (real for TIPS) from the auction day's close, in bp. Treasury par yields start in 1990, real yields in 2003.";

interface TreasuryAuctionsHeadlessDependencies {
  load(args: HeadlessPaneLoadArgs, window: AuctionHistoryWindow): Promise<TreasuryAuctionsResult>;
  curves(shown: readonly TreasuryAuction[], from: string | null): Promise<AuctionCurveRead>;
  hk?(window: AuctionHistoryWindow): Promise<HkTendersResult>;
}

const defaultDependencies: TreasuryAuctionsHeadlessDependencies = {
  load: (_args, window) => loadTreasuryAuctions(false, fetchTreasuryAuctions, window),
  curves: (shown, from) => loadAuctionCurves(shown, from),
  hk: (window) => loadHkTenders(false, window),
};

/** An empty table says what was searched, in which window, and what the search understands; another market's paper, what AUCT covers. */
function emptyNote(query: string, filter: AuctionFilter, historyDays: AuctionHistoryWindow): string {
  if (namesOtherMarket(query)) {
    return `AUCT covers US Treasury auctions and Hong Kong government paper tenders (--market hk); "${query.trim()}" is neither. Search by ${AUCTION_SEARCH_FIELDS}.`;
  }
  const searched = query.trim() ? `match "${query.trim()}"` : "found";
  const group = filter === "all" ? "" : ` in the ${filter} group`;
  return `No auctions ${searched}${group} in ${auctionHistoryPhrase(historyDays)}. Search by ${AUCTION_SEARCH_FIELDS}.`;
}

/** Hong Kong's tenders when `--market hk` asks for them or the search names their paper (`HK 10Y`, `EFB`). */
function marketOf(args: Pick<HeadlessPaneLoadArgs, "argument" | "options">) {
  const named = auctionSearchMarket(typeof args.argument === "string" ? args.argument : "").market;
  return named ?? (isAuctionMarket(args.options.market) ? args.options.market : "us");
}

export function createTreasuryAuctionsHeadless(
  dependencies: TreasuryAuctionsHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    freshness: { source: "US Treasury", status: "not-a-feed", basis: "auction results", observedKey: "auctionDate", oldest: null, tradingDayMarket: "US" },
    argument: {
      kind: "free-text",
      placeholder: "search",
      description: "Optional search: security type, benchmark (10Y), term, CUSIP, or auction date (YYYY-MM-DD). HK, EFB or HKGB lists Hong Kong's tenders.",
      optional: true,
    },
    options: [
      {
        key: "historyDays",
        aliases: ["history"],
        settingKey: "historyDays",
        description: `Auction history window in days, up to 3650 (10 years), or all: every auction since ${AUCTION_HISTORY_START}.`,
        example: "--history-days 3650",
        type: "enum",
        values: AUCTION_HISTORY_WINDOWS.map((days) => ({ value: String(days) })),
        defaultValue: "120",
      },
      {
        key: "market",
        description: "us: US Treasury auctions; hk: Hong Kong government paper tenders (EF Bills and Notes, HKSAR Government Bonds) as the Hong Kong Monetary Authority publishes their results. A search naming HK, EFB or HKGB picks hk.",
        type: "enum",
        values: AUCTION_MARKETS.map((entry) => ({ value: entry.value })),
        defaultValue: "us",
        example: "--market hk",
        pluginState: { pluginId: FIXED_INCOME_VIEW_STATE.treasuryAuctions, key: "market" },
      },
      {
        key: "filter",
        description: "Security type group (Hong Kong: bill is EF Bills, note EF Notes, bond Government Bonds).",
        type: "enum",
        values: [{ value: "all" }, { value: "bill" }, { value: "note" }, { value: "bond" }],
        defaultValue: "all",
        pluginState: { pluginId: FIXED_INCOME_VIEW_STATE.treasuryAuctions, key: "activeTab" },
      },
      {
        key: "view",
        description: "results: each auction's figures; after: its B/C, indirect and dealer percentiles against the tenor's last 24 auctions, and the matching Treasury yield's change 1, 5 and 20 sessions later (bp).",
        type: "enum",
        values: AUCTION_VIEWS.map((value) => ({ value })),
        defaultValue: "results",
        example: "--view after",
        pluginState: { pluginId: FIXED_INCOME_VIEW_STATE.treasuryAuctions, key: "view" },
      },
      {
        key: "sort",
        description: "Row order, by a column: largest first for a figure, newest first for date, A to Z for type, term and CUSIP. An after-view column (btc-pctl, 1d...) shows the after view.",
        type: "enum",
        values: AUCTION_SORT_NAMES.map((entry) => ({ value: entry.value, ...(entry.aliases ? { aliases: entry.aliases } : {}) })),
        example: "--sort btc-pctl",
        pluginState: { pluginId: FIXED_INCOME_VIEW_STATE.treasuryAuctions, key: "sortColumn" },
      },
    ],
    columns: columnsFor("results", []),
    // A search naming Hong Kong (`shot AUCT HK 10Y`) opens the pane on its market, as `fn` reads it.
    shotState: (args) => marketOf(args) === "hk" ? { pluginState: { [FIXED_INCOME_VIEW_STATE.treasuryAuctions]: { market: "hk" } } } : {},
    describe: (args) => {
      const window = auctionHistoryWindow({ historyDays: args.options.historyDays });
      const hk = marketOf(args) === "hk";
      return `${hk ? "Hong Kong Tenders" : "Treasury Auctions"} | ${window === AUCTION_HISTORY_ALL ? "all" : `${window} days`} | ${String(args.options.filter)}`;
    },
    async load(args) {
      const historyDays = auctionHistoryWindow({ historyDays: args.options.historyDays });
      const filter = args.options.filter as AuctionFilter;
      if (marketOf(args) === "hk") {
        return hkTendersReport(await (dependencies.hk ?? defaultDependencies.hk!)(historyDays), {
          search: typeof args.argument === "string" ? args.argument : "",
          filter,
          window: historyDays,
          view: args.options.view === "after" ? "after" : "results",
          sort: typeof args.options.sort === "string" ? args.options.sort : null,
        });
      }
      const sortColumn = typeof args.options.sort === "string" ? auctionSortColumn(args.options.sort) : null;
      // A sort by an after-view column is a request for that view.
      const view: AuctionView = args.options.view === "after" || (sortColumn && isAfterColumn(sortColumn)) ? "after" : "results";
      const sort = sortColumn ? { columnId: sortColumn, direction: firstAuctionSortDirection(sortColumn) } : DEFAULT_AUCTION_SORT;
      const query = typeof args.argument === "string" ? args.argument : "";
      const from = view === "after" ? afterWindowStart(historyDays) : undefined;
      // The after view reads more than it lists, until each listed tenor has its 24 before the oldest row (or ALL).
      let window = view === "after" ? afterLoadWindow(historyDays) : historyDays;
      let result = await dependencies.load(args, window);
      let listed = visibleAuctions(result.auctions, { filter, query, sort: DEFAULT_AUCTION_SORT, from });
      for (let wider = view === "after" ? widerAfterWindow(listed, result.auctions, window) : null; wider;
        wider = widerAfterWindow(listed, result.auctions, window)) {
        window = wider;
        result = await dependencies.load(args, window);
        listed = visibleAuctions(result.auctions, { filter, query, sort: DEFAULT_AUCTION_SORT, from });
      }
      const curves = view === "after" ? await dependencies.curves(listed, from ?? null) : null;
      const after = curves ? projectAuctionAfter(listed, result.auctions, curves.curves) : null;
      const auctions = sortColumn ? visibleAuctions(listed, { filter: "all", query: "", sort, ...(after ? { after } : {}) }) : listed;
      const notes = [
        ...(auctions.length === 0 ? [emptyNote(query, filter, historyDays)] : []),
        // Only where a longer window could list more: never past ALL, for another market, or for a CUSIP whose first auction is listed.
        ...(nextAuctionHistoryWindow(historyDays) && widerWindowCouldAdd(query, auctions, historyDays)
          ? [`Older auctions: use --history-days ${nextAuctionHistoryWindow(historyDays)}.`] : []),
        ...(auctions.length > 0 && view === "results" ? [STOP_OUT_NOTE] : []),
        ...(auctions.length > 0 && view === "after" ? [AFTER_NOTE] : []),
        ...(auctions.some(lacksMetrics) ? [MISSING_METRICS_NOTE] : []),
      ];
      return {
        complete: !result.refreshError && !curves?.errors.length,
        // A saved copy answering the failed refresh ends the report by saying when it was saved instead.
        errors: [unansweredRefreshError(result), ...curves?.errors ?? []].filter((error): error is string => !!error),
        notes,
        columns: columnsFor(view, auctions),
        rows: auctions.map((auction) => ({
          ...auction,
          rate: rateValue(auction),
          stopOutVsAvgBp: stopOutVsAvgBp(auction),
          indirectPercent: indirectPct(auction),
          directPercent: directPct(auction),
          dealerPercent: dealerPct(auction),
          size: auctionSize(auction),
          ...(after ? after.get(auction.id) : {}),
        })),
        metadata: {
          fetchedAt: result.fetchedAt,
          stale: result.stale,
          historyDays,
          filter,
          view,
          ...(sortColumn ? { sort: args.options.sort } : {}),
        },
      };
    },
  };
}

export const treasuryAuctionsHeadless = createTreasuryAuctionsHeadless();
