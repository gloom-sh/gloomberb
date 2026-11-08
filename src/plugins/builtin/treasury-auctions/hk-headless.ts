import type { HkTender } from "../../../api-client/hk-tenders";
import { unansweredRefreshError } from "../../../data/saved-copies";
import type { HeadlessPaneColumn, HeadlessPaneFreshness, HeadlessRowsResult } from "../../../types/headless";
import { AUCTION_HISTORY_ALL, type AuctionHistoryWindow } from "./client";
import {
  DEFAULT_HK_SORT,
  firstHkSortDirection,
  formatHkAmount,
  formatHkRate,
  HK_SEARCH_FIELDS,
  hkDateText,
  hkRate,
  hkSize,
  hkSizeWorkedOut,
  hkSortColumn,
  hkTenderType,
  hkWindowStart,
  isSpread,
  visibleHkTenders,
  type HkTendersResult,
} from "./hk";
import { auctionHistoryPhrase, nextAuctionHistoryWindow, type AuctionFilter } from "./model";

const tender = (row: Record<string, unknown>) => row as unknown as HkTender;
const rate = (value: unknown, row: Record<string, unknown>) => formatHkRate(tender(row), value == null ? null : Number(value), "-");
/** The text says what a floating rate note's figure is, as a US FRN's does; the export keeps the number. */
const rateText = (value: unknown, row: Record<string, unknown>) => `${rate(value, row)}${value != null && isSpread(tender(row)) ? " spread" : ""}`;

const HK_COLUMNS: HeadlessPaneColumn[] = [
  { key: "date", header: "Date", description: "Issue day, the business day after the tender; a Government Bond's issue month, all HKMA's figures give." },
  { key: "type", header: "Type", description: "EFB: Exchange Fund Bills; EFN: Exchange Fund Notes; HKGB: Government Bond; FRN: its HONIA-indexed floating rate note." },
  { key: "term", header: "Term" },
  {
    key: "rate", header: "Rate", align: "right", format: rate, textFormat: rateText,
    description: "Average accepted yield (an RMB bond's annualised); a floating rate note's spread over HONIA, in bp.",
  },
  { key: "bidToCover", header: "B/C", align: "right", format: (value: unknown) => value == null ? "" : Number(value).toFixed(2) },
  {
    // Exports write the bare amount, each row's currency (HKD or CNH) beside it.
    key: "size", header: "Size", align: "right", unitKey: "currency",
    description: "A bond's amount allotted; EF paper's amount offered, worked out from its applications and over-subscription (≈).",
    format: (value: unknown) => value == null ? "" : String(value),
    textFormat: (value: unknown, row: Record<string, unknown>) =>
      formatHkAmount(tender(row), value == null ? null : Number(value), "-", hkSizeWorkedOut(tender(row))),
  },
  { key: "issue", header: "Issue", format: (value: unknown) => value == null ? "" : String(value) },
];

const HK_NOTE = "Hong Kong tenders are the Hong Kong Monetary Authority's tender figures from its Open API (Source: HKMA): "
  + "EF Bills and Notes and HKSAR institutional Government Bonds, dated by issue (a bond by its month). "
  + "EF paper's B/C is one plus HKMA's over-subscription, and its size the amount offered that implies (≈).";

const HK_FRESHNESS: HeadlessPaneFreshness = {
  source: "HKMA", publisher: "Hong Kong Monetary Authority", status: "not-a-feed", basis: "monthly tender figures", observedKey: "date", oldest: null,
  tradingDayMarket: "HK",
};

/** An empty list says what was searched, in which window, and what the search understands. */
function emptyNote(search: string, filter: AuctionFilter, window: AuctionHistoryWindow): string {
  const searched = search.trim() ? `match "${search.trim()}"` : "found";
  const group = filter === "all" ? "" : ` in the ${filter} group`;
  const phrase = window === AUCTION_HISTORY_ALL ? "every tender on record" : auctionHistoryPhrase(window);
  return `No Hong Kong tenders ${searched}${group} in ${phrase}. Search by ${HK_SEARCH_FIELDS}.`;
}


/**
 * HKMA publishes these figures a month at a time, after the tenders: how far
 * each paper's run, so a missing recent tender reads as not published yet.
 */
function hkRunsToNote(runsTo: HkTendersResult["runsTo"]): string | null {
  const parts = [
    runsTo.efb && `${hkDateText(runsTo.efb)} for EF Bills`,
    runsTo.efn && `${hkDateText(runsTo.efn)} for EF Notes`,
    runsTo.hkgb && `${hkDateText(runsTo.hkgb)} for Government Bonds`,
  ].filter(Boolean);
  return parts.length ? `HKMA publishes its tender figures monthly; they run to ${parts.join(", ")}.` : null;
}

/** `fn AUCT --market hk` (or a search naming Hong Kong's paper): HKMA's tender figures, in the AUCT report's shape. */
export function hkTendersReport(
  result: HkTendersResult,
  options: { search: string; filter: AuctionFilter; window: AuctionHistoryWindow; view: "results" | "after"; sort: string | null },
): HeadlessRowsResult {
  const { search, filter, window } = options;
  const sortColumn = options.sort ? hkSortColumn(options.sort) : null;
  const sort = sortColumn ? { columnId: sortColumn, direction: firstHkSortDirection(sortColumn) } : DEFAULT_HK_SORT;
  const from = hkWindowStart(window);
  const tenders = visibleHkTenders(result.tenders, { filter, query: search, sort, from });
  const next = nextAuctionHistoryWindow(window);
  // A wider window adds rows only where the record goes back past this one's start.
  const widerAdds = !!next && !!from && !!result.firstTender && result.firstTender < from;
  const runsTo = hkRunsToNote(result.runsTo);
  const notes = [
    ...(tenders.length === 0 ? [emptyNote(search, filter, window)] : []),
    ...(widerAdds ? [`Older tenders: use --history-days ${next}.`] : []),
    ...(options.view === "after" ? ["The after view ranks US Treasury auctions; Hong Kong tenders list their results."] : []),
    ...(options.sort && !sortColumn ? [`--sort ${options.sort} is a US Treasury column; Hong Kong tenders are listed newest first.`] : []),
    ...(tenders.length > 0 ? [HK_NOTE] : []),
    ...(runsTo ? [runsTo] : []),
  ];
  return {
    complete: !result.refreshError && !result.truncated,
    errors: [unansweredRefreshError(result)].filter((error): error is string => !!error),
    notes,
    columns: HK_COLUMNS,
    rowUnitKey: "currency",
    rows: tenders.map((entry) => ({
      ...entry,
      type: hkTenderType(entry),
      rate: hkRate(entry),
      size: hkSize(entry),
    })),
    freshness: HK_FRESHNESS,
    metadata: {
      fetchedAt: result.fetchedAt,
      stale: result.stale,
      market: "hk",
      historyDays: window,
      filter,
      runsTo: result.runsTo,
      firstTender: result.firstTender,
      ...(sortColumn ? { sort: options.sort } : {}),
    },
  };
}
