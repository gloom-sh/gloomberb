import type {
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import type { HeadlessPaneColumn } from "../../../types/headless";
import {
  afterLoadWindow, afterWindowStart, AUCTION_VIEWS, auctionPercentiles, loadAuctionCurves, projectAuctionAfter, widerAfterWindow,
  type AfterMove, type AuctionAfter, type AuctionCurveRead, type AuctionView,
} from "./after";
import { isoDateOption } from "../../../utils/calendar-date";
import { LIKE_LIMIT, likeTarget, rankAuctionAnalogs, summarizeAnalogMoves, type AuctionAnalog } from "./like";
import { MISSING_VALUE, formatCompact } from "../../../utils/format";
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
  dealerPct,
  DEFAULT_AUCTION_SORT,
  directPct,
  formatAuctionRate,
  indirectPct,
  isAfterColumn,
  isBill,
  isPendingAuction,
  namesOtherMarket,
  nextAuctionHistoryWindow,
  normalizeAuctionSortOption,
  parseAuctionSort,
  publishesMedian,
  auctionSortName,
  rateColumnLabel,
  rateQualifier,
  rateValue,
  stopOutColumnLabel,
  stopOutVsAvgBp,
  visibleAuctions,
  widerWindowCouldAdd,
  type AuctionFilter,
  type AuctionSortPreference,
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
  const text = formatAuctionRate(row as unknown as TreasuryAuction, value == null ? null : Number(value), pending(row) ? RESULTS_NOT_PUBLISHED : MISSING_VALUE);
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
      row as unknown as TreasuryAuction, value == null ? null : Number(value), pending(row) ? RESULTS_NOT_PUBLISHED : MISSING_VALUE,
    ),
    textFormat: rateCell,
  },
];

/** A bill's high discount rate, beside the investment rate its Rate is: the rate Treasury's announcement leads with. */
const DISCOUNT_RATE_COLUMN: HeadlessPaneColumn = {
  key: "highDiscountRate", header: "Discount rate", align: "right" as const,
  format: (value: unknown, row: Record<string, unknown>) => value == null ? pending(row) ? "" : MISSING_VALUE : `${Number(value).toFixed(3)}%`,
};

const STOP_OUT_COLUMN: HeadlessPaneColumn = {
  // Exports keep the name scripts read it by: the spread against the published average, or the median from November 1998.
  key: "stopOutVsAvgBp", header: "Stop-out vs avg (bp)", align: "right" as const,
  format: (value: unknown, row: Record<string, unknown>) => value == null ? pending(row) ? "" : MISSING_VALUE : Number(value).toFixed(1),
};
const BTC_COLUMN: HeadlessPaneColumn = {
  key: "bidToCoverRatio", header: "B/C", align: "right" as const, format: (value: unknown) => value == null ? "" : Number(value).toFixed(2),
};
const INDIRECT_COLUMN: HeadlessPaneColumn = { key: "indirectPercent", header: "Indirect", align: "right" as const, format: formatPercent };

const RESULT_COLUMNS: HeadlessPaneColumn[] = [
  STOP_OUT_COLUMN,
  BTC_COLUMN,
  INDIRECT_COLUMN,
  { key: "directPercent", header: "Direct", align: "right" as const, format: formatPercent },
  { key: "dealerPercent", header: "Dealer", align: "right" as const, format: formatPercent },
  { key: "size", header: "Size", align: "right" as const, format: (value: unknown) => value == null ? MISSING_VALUE : `$${formatCompact(Number(value))}` },
  { key: "cusip", header: "CUSIP" },
];

const percentile = (value: unknown) => value == null ? "" : String(value);
const bpMove = (value: unknown) => value == null ? "" : `${Number(value) > 0 ? "+" : ""}${Number(value).toFixed(0)}`;

const STOP_OUT_PERCENTILE_COLUMN: HeadlessPaneColumn = { key: "stopOutPercentile", header: "Stop-out pctl", align: "right" as const, format: percentile };
const MOVE_COLUMNS: HeadlessPaneColumn[] = [
  { key: "cmt", header: "Yield", description: "The Treasury par yield the moves are read on: the auction's tenor, real for a TIPS." },
  { key: "after1d", header: "+1d (bp)", align: "right" as const, format: bpMove },
  { key: "after5d", header: "+5d (bp)", align: "right" as const, format: bpMove },
  { key: "after20d", header: "+20d (bp)", align: "right" as const, format: bpMove },
];

/**
 * The after view: each auction's stop-out, B/C and indirect share beside where
 * they rank against its tenor's last 24, and the matching Treasury yield's
 * moves after it, so a weak auction is found from one export.
 */
const AFTER_COLUMNS: HeadlessPaneColumn[] = [
  STOP_OUT_COLUMN,
  STOP_OUT_PERCENTILE_COLUMN,
  BTC_COLUMN,
  { key: "btcPercentile", header: "B/C pctl", align: "right" as const, format: percentile },
  INDIRECT_COLUMN,
  { key: "indirectPercentile", header: "Indirect pctl", align: "right" as const, format: percentile },
  { key: "dealerPercentile", header: "Dealer pctl", align: "right" as const, format: percentile },
  ...MOVE_COLUMNS,
  { key: "cusip", header: "CUSIP" },
];

/** A move a backtest leaves blank: its later close falls after the date `--like` asked about. */
const AFTER_ASKED_DATE = "after the asked date";

/** `--like`: the after view's figures less the dealer's, and how far each auction ranked from the one asked about. */
const LIKE_COLUMNS: HeadlessPaneColumn[] = [
  ...AFTER_COLUMNS.filter((column) => column.key !== "dealerPercentile" && column.key !== "cmt" && !column.key.startsWith("after") && column.key !== "cusip"),
  {
    key: "distance", header: "Distance", align: "right" as const, format: (value: unknown) => value == null ? "" : Number(value).toFixed(1),
    description: "Root mean square of the gaps between this auction's percentiles and the one asked about, 0 to 100: 0 ranked the same.",
  },
  ...MOVE_COLUMNS.map((column) => column.key === "cmt" ? column : {
    ...column,
    // The export leaves the cell blank and says why in the row's status.
    format: (value: unknown, row: Record<string, unknown>) => value == null && Array.isArray(row.afterAskedDate) && row.afterAskedDate.includes(column.key)
      ? AFTER_ASKED_DATE : bpMove(value),
  }),
  { key: "cusip", header: "CUSIP" },
];

/** The columns a board lists: a bill board heads its rate as the investment rate and puts the discount rate beside it. */
function columnsFor(view: AuctionView | "like", auctions: readonly TreasuryAuction[]): HeadlessPaneColumn[] {
  const rate = { ...LEAD_COLUMNS[3]!, textHeader: rateColumnLabel(auctions, "report") };
  const discount = auctions.some(isBill) ? [DISCOUNT_RATE_COLUMN] : [];
  // The spread is against the median from November 1998 and the average before: the heading says which the rows hold.
  const figures = (view === "after" ? AFTER_COLUMNS : view === "like" ? LIKE_COLUMNS : RESULT_COLUMNS)
    .map((column) => column.key === "stopOutVsAvgBp" ? { ...column, textHeader: stopOutColumnLabel(auctions, "report") } : column);
  return [...LEAD_COLUMNS.slice(0, 3), rate, ...discount, ...figures];
}

const AFTER_NOTE = "Percentiles rank each auction against its tenor's previous 24 (at least 12), the stop-out against those on the same footing "
  + "(median from November 1998, average before); the moves are the Treasury par yield "
  + "of its tenor (real for TIPS) from the auction day's close, in bp. Treasury par yields start in 1990, real yields in 2003.";

const LIKE_NOTE = `--like lists the ${LIKE_LIMIT} earlier auctions of the tenor, from every one since ${AUCTION_HISTORY_START}, `
  + "whose stop-out vs median, B/C and indirect percentiles are closest to the one asked about: Distance is the root mean square of the gaps, "
  + "and an auction missing a percentile the other has is left out. The summary is the median move of the Treasury par yield after them and the share that rose; "
  + `a move whose later close falls after the asked date is blank (${AFTER_ASKED_DATE}) and not counted, so a past date reads only what was known then.`;

/** `--like` with Hong Kong's tenders: they have no percentiles to rank by. */
const HK_LIKE_REFUSAL = "--like ranks US Treasury auctions by their percentiles against their tenor; Hong Kong's tenders have no percentiles. "
  + "Leave out --like to list them, or ask about a US auction: fn AUCT 3Y --like 2026-11-09.";

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

/** The market `--market` names; without it Hong Kong's when the search names its paper (`HK 10Y`, `EFB`), else the US. */
function marketOf(args: Pick<HeadlessPaneLoadArgs, "argument" | "options">) {
  if (isAuctionMarket(args.options.market)) return args.options.market;
  return auctionSearchMarket(typeof args.argument === "string" ? args.argument : "").market ?? "us";
}

export function createTreasuryAuctionsHeadless(
  dependencies: TreasuryAuctionsHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    // A tail is read against the when-issued yield, which AUCT cannot show (its source has none), but its stop-out vs median is the nearest
    // figure: `catalog when issued`, `catalog WI` and `catalog tail` list AUCT first, with the glossary's Tail.
    discovery: { suggestFor: ["WI", "when issued", "when-issued", "tail", "auction tail"] },
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
        // No default: a search naming HK, EFB or RMB picks hk unless --market says otherwise.
        description: "us (without it, unless the search names Hong Kong's paper): US Treasury auctions; hk: Hong Kong government paper tenders (EF Bills and Notes, HKSAR Government Bonds) from HKMA's Open API. A search naming HK, EFB, HKGB or RMB picks hk.",
        type: "enum",
        values: AUCTION_MARKETS.map((entry) => ({ value: entry.value })),
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
        description: "Row order, by a column: largest first for a figure, newest first for date, A to Z for type, term and CUSIP; "
          + "a leading - the other way (-indirect-pctl: lowest first). An after-view column (vs-median-pctl, btc-pctl, 1d...) shows the after view.",
        type: "enum",
        values: AUCTION_SORT_NAMES.map((entry) => ({ value: entry.value, ...(entry.aliases ? { aliases: entry.aliases } : {}) })),
        example: "--sort btc-pctl",
        examples: ["--sort=-indirect-pctl"],
        normalize: normalizeAuctionSortOption,
        pluginState: { pluginId: FIXED_INCOME_VIEW_STATE.treasuryAuctions, key: "sortColumn" },
      },
      {
        key: "like",
        type: "string",
        placeholder: "date",
        description: `An auction's day (YYYY-MM-DD): the ${LIKE_LIMIT} earlier auctions of its tenor, from every one since ${AUCTION_HISTORY_START}, `
          + "whose stop-out vs median, B/C and indirect percentiles are closest to it, with the Treasury yield's moves after each, "
          + "their median and the share that rose. The search picks the auction when the day held several.",
        example: "--like 2026-11-09",
        normalize: (value) => isoDateOption(value, "like"),
        shot: { reportOnly: "ranks the auctions most like one in the text report, which the pane does not list" },
      },
    ],
    columns: columnsFor("results", []),
    // A search naming Hong Kong (`shot AUCT HK 10Y`) opens the pane on its market, as `fn` reads it.
    shotState: (args) => marketOf(args) === "hk" ? { pluginState: { [FIXED_INCOME_VIEW_STATE.treasuryAuctions]: { market: "hk" } } } : {},
    describe: (args) => {
      const window = auctionHistoryWindow({ historyDays: args.options.historyDays });
      const hk = marketOf(args) === "hk";
      // --like reads every auction, whatever the window.
      if (!hk && typeof args.options.like === "string" && args.options.like) return `Treasury Auctions | like ${args.options.like} | ${String(args.options.filter)}`;
      return `${hk ? "Hong Kong Tenders" : "Treasury Auctions"} | ${window === AUCTION_HISTORY_ALL ? "all" : `${window} days`} | ${String(args.options.filter)}`;
    },
    async load(args) {
      const historyDays = auctionHistoryWindow({ historyDays: args.options.historyDays });
      const filter = args.options.filter as AuctionFilter;
      if (marketOf(args) === "hk") {
        if (typeof args.options.like === "string" && args.options.like) throw new Error(HK_LIKE_REFUSAL);
        return {
          ...hkTendersReport(await (dependencies.hk ?? defaultDependencies.hk!)(historyDays), {
            search: typeof args.argument === "string" ? args.argument : "",
            filter,
            window: historyDays,
            view: args.options.view === "after" ? "after" : "results",
            sort: typeof args.options.sort === "string" ? args.options.sort : null,
          }),
          // Hong Kong's tenders list their results whatever --view asked.
          appliedOptions: { market: "hk", view: "results" },
        };
      }
      const sorted = typeof args.options.sort === "string" ? parseAuctionSort(args.options.sort) : null;
      const sortColumn = sorted?.columnId ?? null;
      const query = typeof args.argument === "string" ? args.argument : "";
      if (typeof args.options.like === "string" && args.options.like) {
        return likeReport(await dependencies.load(args, AUCTION_HISTORY_ALL), dependencies, { date: args.options.like, filter, query, sort: sorted });
      }
      // A sort by an after-view column is a request for that view.
      const view: AuctionView = args.options.view === "after" || (sortColumn && isAfterColumn(sortColumn)) ? "after" : "results";
      const sort = sorted ?? DEFAULT_AUCTION_SORT;
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
        rows: auctions.map((auction) => auctionRow(auction, after?.get(auction.id))),
        // The view shown: a sort by an after column shows the after view whatever --view said.
        appliedOptions: { market: "us", view },
        metadata: {
          fetchedAt: result.fetchedAt,
          stale: result.stale,
          market: "us",
          historyDays,
          filter,
          view,
          ...(sorted ? { sort: auctionSortName(sorted) } : {}),
        },
      };
    },
  };
}

/** An auction as the report lists it: its figures worked out beside the source's fields, and the after view's when it has them. */
function auctionRow(auction: TreasuryAuction, after?: AuctionAfter, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...auction,
    rate: rateValue(auction),
    stopOutVsAvgBp: stopOutVsAvgBp(auction),
    indirectPercent: indirectPct(auction),
    directPercent: directPct(auction),
    dealerPercent: dealerPct(auction),
    size: auctionSize(auction),
    ...after,
    ...extra,
  };
}

const ordinal = (value: number) => {
  const tens = value % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ["th", "st", "nd", "rd"][value % 10] ?? "th";
  return `${value}${suffix}`;
};

/** "stop-out vs median 1.0bp (88th pctl), B/C 2.46 (25th), indirect 61.2% (0th)": what the auction asked about ranked. */
function likeFigures(auction: TreasuryAuction, after: AuctionAfter | undefined): string {
  const figures: Array<[string, number | null | undefined]> = [];
  const stopOut = stopOutVsAvgBp(auction);
  if (stopOut != null) figures.push([`stop-out vs ${publishesMedian(auction) ? "median" : "average"} ${stopOut.toFixed(1)}bp`, after?.stopOutPercentile]);
  if (auction.bidToCoverRatio != null) figures.push([`B/C ${auction.bidToCoverRatio.toFixed(2)}`, after?.btcPercentile]);
  const indirect = indirectPct(auction);
  if (indirect != null) figures.push([`indirect ${indirect.toFixed(1)}%`, after?.indirectPercentile]);
  // The first percentile says what it is; the rest read the same way.
  let named = false;
  return figures.map(([text, rank]) => {
    if (rank == null) return text;
    const ranked = `${text} (${ordinal(rank)}${named ? "" : " pctl"})`;
    named = true;
    return ranked;
  }).join(", ");
}

const SUMMARY_COLUMNS: HeadlessPaneColumn[] = [
  { key: "move", header: "After" },
  { key: "medianBp", header: "Median (bp)", align: "right" as const, format: (value: unknown) => value == null ? "" : bpMove(Math.round(Number(value))) },
  { key: "rosePct", header: "Rose (%)", align: "right" as const, format: (value: unknown) => value == null ? "" : String(value) },
  { key: "count", header: "Auctions", align: "right" as const },
];

/**
 * `--like <date>`: the auction held that day (narrowed by the search), the
 * earlier auctions of its tenor whose percentiles are closest to its, and the
 * Treasury yield's moves after them, summed up as the median and the share
 * that rose. Reads every auction since 1979, whatever the window.
 */
async function likeReport(
  result: TreasuryAuctionsResult,
  dependencies: TreasuryAuctionsHeadlessDependencies,
  options: { date: string; filter: AuctionFilter; query: string; sort: AuctionSortPreference | null },
) {
  const listed = visibleAuctions(result.auctions, { filter: options.filter, query: options.query, sort: DEFAULT_AUCTION_SORT });
  const found = likeTarget(listed, options.date);
  if ("error" in found) throw new Error(found.error);
  const { target } = found;
  const percentiles = auctionPercentiles(result.auctions);
  const { dimensions, analogs } = rankAuctionAnalogs(target, result.auctions, percentiles);
  const name = `${target.securityTerm} ${target.secType.toLowerCase()} of ${target.auctionDate}`;
  if (dimensions.length === 0) {
    throw new Error(`The ${name} has no percentile to compare: fewer than 12 auctions of its tenor came before it.`);
  }
  const shown = [target, ...analogs.map((analog) => analog.auction)];
  const curves = await dependencies.curves(shown, null);
  // No look-ahead: an earlier auction's move whose later close falls after the asked date is blank.
  const after = projectAuctionAfter(shown, result.auctions, curves.curves, target.auctionDate);
  const distance = new Map(analogs.map((analog) => [analog.auction.id, analog.distance]));
  const order: AuctionAnalog[] = options.sort
    ? visibleAuctions(analogs.map((analog) => analog.auction), { filter: "all", query: "", sort: options.sort, after })
      .map((auction) => ({ auction, distance: distance.get(auction.id)! }))
    : analogs;
  const summary = summarizeAnalogMoves(analogs, after);
  const cmt = after.get(target.id)?.cmt;
  const summaryTitle = cmt ? `${cmt} yield after them` : "Treasury yield after them";
  const summaryRows = summary.map((entry) => ({ move: entry.label, medianBp: entry.medianBp, rosePct: entry.rosePct, count: entry.count }));
  const auctions = order.map((analog) => analog.auction);
  return {
    complete: !result.refreshError && !curves.errors.length,
    errors: [unansweredRefreshError(result), ...curves.errors].filter((error): error is string => !!error),
    notes: [
      ...(analogs.length === 0 ? [`No earlier ${target.securityTerm} ${target.secType.toLowerCase()} auction has the percentiles to compare.`] : []),
      LIKE_NOTE,
      ...(auctions.some(lacksMetrics) ? [MISSING_METRICS_NOTE] : []),
    ],
    columns: columnsFor("like", auctions),
    rows: order.map((analog) => {
      const figures = after.get(analog.auction.id);
      // JSON says why a move is blank as the export's status column does: "+20d (bp): after the asked date".
      const late = MOVE_COLUMNS.filter((column) => figures?.afterAskedDate?.includes(column.key as AfterMove)).map((column) => column.header);
      return auctionRow(analog.auction, figures, { distance: analog.distance, ...late.length ? { status: `${late.join(", ")}: ${AFTER_ASKED_DATE}` } : {} });
    }),
    ...(analogs.length ? {
      textSections: [{ title: summaryTitle, columns: SUMMARY_COLUMNS, rows: summaryRows }],
      exportTables: [{ title: summaryTitle, columns: SUMMARY_COLUMNS, rows: summaryRows, unit: "bp" }],
    } : {}),
    // The report is about the auction asked about, not the oldest one like it.
    freshness: { asOf: target.auctionDate },
    appliedOptions: { market: "us", view: "after" },
    metadata: {
      fetchedAt: result.fetchedAt,
      stale: result.stale,
      market: "us",
      historyDays: AUCTION_HISTORY_ALL,
      filter: options.filter,
      view: "after",
      notices: [`Like the ${name}: ${likeFigures(target, after.get(target.id))}.`],
      // The auction asked about, with its figures and percentiles, the percentiles compared, and the summary.
      like: { ...auctionRow(target, after.get(target.id)), compared: dimensions, summary },
      ...(options.sort ? { sort: auctionSortName(options.sort) } : {}),
    },
  };
}

export const treasuryAuctionsHeadless = createTreasuryAuctionsHeadless();
