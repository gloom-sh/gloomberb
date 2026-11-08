import type { HkTender } from "../../../api-client/hk-tenders";
import { unansweredRefreshError } from "../../../data/saved-copies";
import type { HeadlessPaneColumn, HeadlessPaneFreshness, HeadlessRowsResult } from "../../../types/headless";
import { AUCTION_HISTORY_ALL, type AuctionHistoryWindow } from "./client";
import {
  DEFAULT_HK_SORT,
  isSpread,
  firstHkSortDirection,
  formatHkAmount,
  formatHkRate,
  HK_SEARCH_FIELDS,
  hkAverage,
  hkHighest,
  hkSortColumn,
  hkTenderType,
  hkWindowStart,
  visibleHkTenders,
  type HkTendersResult,
} from "./hk";
import { auctionHistoryPhrase, nextAuctionHistoryWindow, type AuctionFilter } from "./model";

const tender = (row: Record<string, unknown>) => row as unknown as HkTender;
const rate = (value: unknown, row: Record<string, unknown>) => formatHkRate(tender(row), value == null ? null : Number(value), "-");
/** The text says what a floating rate note's figure is, as a US FRN's does; the export keeps the number. */
const rateText = (value: unknown, row: Record<string, unknown>) => `${rate(value, row)}${value != null && isSpread(tender(row)) ? " spread" : ""}`;

const HK_COLUMNS: HeadlessPaneColumn[] = [
  { key: "tenderDate", header: "Date" },
  { key: "type", header: "Type", description: "EFB: Exchange Fund Bills; EFN: Exchange Fund Notes; HKGB: Government Bond; FRN: its HONIA-indexed floating rate note." },
  { key: "term", header: "Term" },
  { key: "highest", header: "Highest yield", align: "right", format: rate, textFormat: rateText, description: "Highest accepted yield; a floating rate note's highest accepted spread over HONIA, in bp." },
  { key: "average", header: "Average yield", align: "right", format: rate, textFormat: rateText, description: "Average accepted yield; a floating rate note's average accepted spread over HONIA, in bp." },
  { key: "bidToCover", header: "B/C", align: "right", format: (value: unknown) => value == null ? "" : Number(value).toFixed(2) },
  {
    key: "allotted", header: "Size", align: "right", description: "Amount allotted, in the issue's currency (HK$, or RMB for an RMB bond).",
    format: (value: unknown, row: Record<string, unknown>) => formatHkAmount(tender(row), value == null ? null : Number(value), "-"),
  },
  { key: "issue", header: "Issue" },
];

const HK_NOTE = "Hong Kong tenders are each competitive tender's result as the Hong Kong Monetary Authority publishes it: "
  + "EF Bills and Notes and HKSAR Institutional Government Bonds. A bill's B/C is the amount applied for over the amount allotted.";

const HK_FRESHNESS: HeadlessPaneFreshness = {
  source: "Hong Kong Monetary Authority", status: "not-a-feed", basis: "tender results", observedKey: "tenderDate", oldest: null, tradingDayMarket: "HK",
};

/** An empty list says what was searched, in which window, and what the search understands. */
function emptyNote(search: string, filter: AuctionFilter, window: AuctionHistoryWindow): string {
  const searched = search.trim() ? `match "${search.trim()}"` : "found";
  const group = filter === "all" ? "" : ` in the ${filter} group`;
  const phrase = window === AUCTION_HISTORY_ALL ? "every tender on record" : auctionHistoryPhrase(window);
  return `No Hong Kong tenders ${searched}${group} in ${phrase}. Search by ${HK_SEARCH_FIELDS}.`;
}

/** `fn AUCT --market hk` (or a search naming Hong Kong's paper): HKMA's tender results, in the AUCT report's shape. */
export function hkTendersReport(
  result: HkTendersResult,
  options: { search: string; filter: AuctionFilter; window: AuctionHistoryWindow; view: "results" | "after"; sort: string | null },
): HeadlessRowsResult {
  const { search, filter, window } = options;
  const sortColumn = options.sort ? hkSortColumn(options.sort) : null;
  const sort = sortColumn ? { columnId: sortColumn, direction: firstHkSortDirection(sortColumn) } : DEFAULT_HK_SORT;
  const tenders = visibleHkTenders(result.tenders, { filter, query: search, sort, from: hkWindowStart(window) });
  const next = nextAuctionHistoryWindow(window);
  const notes = [
    ...(tenders.length === 0 ? [emptyNote(search, filter, window)] : []),
    ...(next && !/\d{4}-\d{2}-\d{2}/.test(search) ? [`Older tenders: use --history-days ${next}.`] : []),
    ...(options.view === "after" ? ["The after view ranks US Treasury auctions; Hong Kong tenders list their results."] : []),
    ...(options.sort && !sortColumn ? [`--sort ${options.sort} is a US Treasury column; Hong Kong tenders are listed newest first.`] : []),
    ...(tenders.length > 0 ? [HK_NOTE] : []),
  ];
  return {
    complete: !result.refreshError,
    errors: [unansweredRefreshError(result)].filter((error): error is string => !!error),
    notes,
    columns: HK_COLUMNS,
    rows: tenders.map((entry) => ({
      ...entry,
      type: hkTenderType(entry),
      highest: hkHighest(entry),
      average: hkAverage(entry),
    })),
    freshness: HK_FRESHNESS,
    metadata: {
      fetchedAt: result.fetchedAt,
      stale: result.stale,
      market: "hk",
      historyDays: window,
      filter,
      ...(sortColumn ? { sort: options.sort } : {}),
    },
  };
}
