import { MISSING_VALUE } from "../../../utils/format";
import { useCallback, useMemo } from "react";
import type { HkTender } from "../../../api-client/hk-tenders";
import {
  KeyValueRow,
  useExternalLinkFooter,
  type DataTableCell,
  type QueryBarSelectFilter,
} from "../../../components";
import { loadingErrorFooterInfo } from "../../../components/data-table/table-pane";
import { ageFooterSegment, savedCopyFooterInfo } from "../../../components/layout/pane/footer";
import { STALE_SEGMENT } from "../../../components/layout/pane/status-footer";
import { useAsyncResource } from "../../../react/async-resource";
import { useUtcDay } from "../../../react/auto-refresh";
import { reportFooterSegment } from "../shared/source-footer";
import { treasuryAuctionsHeadless } from "./headless";
import { hkTendersReport } from "./hk-headless";
import { colors } from "../../../theme/colors";
import { Box, ScrollBox, Text, TextAttributes } from "../../../ui";
import { formatRelativeAge, formatShortDate } from "../../../utils/datetime-format";
import { cycleSortPreference, nextHeaderSort } from "../../../utils/sort-values";
import type { AuctionHistoryWindow } from "./client";
import { AuctionMarketView, useAuctionMarketShell } from "./market-shell";
import {
  buildHkColumns,
  DEFAULT_HK_SORT,
  firstHkSortDirection,
  hkTenderTerm,
  formatHkAmount,
  formatHkRate,
  HK_SEARCH_FIELDS,
  HK_SORT_COLUMN_IDS,
  hkDatasetPage,
  hkDateText,
  hkRate,
  hkSize,
  hkSizeWorkedOut,
  hkSortName,
  hkTenderId,
  hkTenderName,
  hkTenderType,
  isSpread,
  loadHkTenders,
  parseHkSort,
  visibleHkTenders,
  hkWindowStart,
  type HkColumn,
  type HkSortPreference,
} from "./hk";
import {
  auctionDatesShowYear,
  type AuctionFilter,
} from "./model";
import { TREASURY_AUCTIONS_PANE_ID } from "./types";
import { auctionViewHints } from "./keys";

const NO_TENDERS: HkTender[] = [];

/** A kept sort's name (`btc:asc`, `-btc`) as Hong Kong's columns read it; a US-only one is the default. */
function readHkSort(value: string | null): HkSortPreference {
  const [name, direction] = (value ?? "").split(":");
  const sort = name ? parseHkSort(name) : null;
  if (!sort) return DEFAULT_HK_SORT;
  return direction === "asc" || direction === "desc" ? { columnId: sort.columnId, direction } : sort;
}

const writeHkSort = (sort: HkSortPreference) => `${hkSortName(sort.columnId)}:${sort.direction}`;

function typeColor(tender: HkTender, selected: boolean): string {
  if (selected) return colors.selectedText;
  return tender.paper === "efb" ? colors.positive : tender.paper === "efn" ? colors.textBright : colors.warning;
}

function renderTenderCell(tender: HkTender, column: HkColumn, rowState: { selected: boolean }, showYear: boolean): DataTableCell {
  const selected = rowState.selected ? colors.selectedText : undefined;
  switch (column.id) {
    case "date":
      return { text: hkTableDate(tender.date, showYear), color: selected ?? colors.textDim };
    case "type":
      return { text: hkTenderType(tender), color: typeColor(tender, rowState.selected), attributes: TextAttributes.BOLD };
    case "term":
      return { text: hkTenderTerm(tender), color: selected ?? colors.text };
    case "rate":
      return { text: formatHkRate(tender, hkRate(tender), MISSING_VALUE), color: selected ?? colors.textBright };
    case "btc":
      return { text: tender.bidToCover.toFixed(2), color: selected ?? colors.text };
    case "size":
      return { text: formatHkAmount(tender, hkSize(tender), MISSING_VALUE, hkSizeWorkedOut(tender)), color: selected ?? colors.textDim };
    case "cusip":
      return { text: tender.issue ?? "", color: selected ?? colors.textDim };
  }
}

/** A column of days, short ("28 Oct") or with the year ("28 Oct 2026"); a bond's issue month as "May" or "May 2026". */
function hkTableDate(date: string, showYear: boolean): string {
  if (showYear) return hkDateText(date);
  if (date.length === 7) return hkDateText(date).replace(/ \d{4}$/, "");
  return formatShortDate(date, { year: false, utc: true, fallback: MISSING_VALUE });
}

const percent = (value: number | null) => value == null ? MISSING_VALUE : `${value.toFixed(3)}%`;
const times = (value: number | null) => value == null ? MISSING_VALUE : value.toFixed(2);

function HkTenderDetail({ tender, width }: { tender: HkTender; width: number }) {
  const row = (label: string, value: string) => (
    <KeyValueRow labelWidth={22} width={Math.max(1, width - 2)} emphasis={false} label={label} value={value} />
  );
  return (
    <ScrollBox flexGrow={1} scrollY>
      <Box flexDirection="column" paddingX={1} width={width}>
        <Box flexDirection="row" height={1} gap={2}>
          <Text fg={colors.textDim}>{`issued ${hkDateText(tender.date)}`}</Text>
          {tender.issue && <Text fg={colors.textDim}>{tender.issue}</Text>}
          {tender.reopening && <Text fg={colors.textDim}>{`re-opening of a ${tender.term} issue`}</Text>}
        </Box>
        <Box height={1} />
        {isSpread(tender)
          ? row("Spread over HONIA", formatHkRate(tender, hkRate(tender), MISSING_VALUE))
          : row("Average yield", percent(tender.averageYield))}
        {/* An RMB bond's average yield is annualised; HKMA gives it semi-annualised too. */}
        {tender.averageYieldSemiAnnual != null && row("Semi-annual basis", percent(tender.averageYieldSemiAnnual))}
        {row("Bid-to-cover", times(tender.bidToCover))}
        {tender.overSubscription != null && row("Over-subscription", times(tender.overSubscription))}
        <Box height={1} />
        {row("Applied", formatHkAmount(tender, tender.applied))}
        {tender.allotted != null && row("Allotted", formatHkAmount(tender, tender.allotted))}
        {tender.offered != null && row("Offered (worked out)", formatHkAmount(tender, tender.offered, MISSING_VALUE, true))}
        {tender.coupon != null && row("Coupon", percent(tender.coupon))}
        {tender.maturity && row("Maturity", hkDateText(tender.maturity))}
        <Box height={1} />
        <Text fg={colors.textDim}>Source: HKMA</Text>
      </Box>
    </ScrollBox>
  );
}

/** How far HKMA's figures run for the paper a group lists: they come a month at a time, after the tenders. */
interface HkTendersViewProps {
  focused: boolean;
  width: number;
  height: number;
  historyDays: AuctionHistoryWindow;
  filter: AuctionFilter;
  setFilter: (next: AuctionFilter) => void;
  searchQuery: string;
  setSearchQuery: (next: string) => void;
  sortValue: string | null;
  setSortValue: (next: string | null) => void;
  marketFilter: QueryBarSelectFilter<string>;
}

/** AUCT's Hong Kong market: HKMA's tender figures for EF Bills and Notes and Government Bonds, from its Open API. */
export function HkTendersView({
  focused, width, height, historyDays, filter, setFilter, searchQuery, setSearchQuery, sortValue, setSortValue, marketFilter,
}: HkTendersViewProps) {
  const sort = useMemo(() => readHkSort(sortValue), [sortValue]);
  const loadTenders = useCallback((force: boolean) => loadHkTenders(force, historyDays), [historyDays]);
  const resource = useAsyncResource(loadTenders, {
    keepPreviousData: true,
    savedCopy: { key: ["treasury-auctions", "hk", historyDays] },
  });
  const tenders = resource.data?.tenders ?? NO_TENDERS;
  const stale = resource.data?.stale ?? false;
  const fetchedAt = resource.data?.fetchedAt ?? null;
  const savedAt = resource.data?.savedAt ?? null;
  const error = resource.error ?? (resource.loading || savedAt != null ? null : resource.data?.refreshError ?? null);
  const loading = resource.loading && !resource.data;

  const rows = useMemo(
    () => visibleHkTenders(tenders, { filter, query: searchQuery, sort, from: hkWindowStart(historyDays) }),
    [filter, historyDays, searchQuery, sort, tenders],
  );

  const cycleSort = useCallback((step: 1 | -1) => {
    const next = cycleSortPreference(HK_SORT_COLUMN_IDS, sort, step);
    setSortValue(writeHkSort({ columnId: next.columnId ?? DEFAULT_HK_SORT.columnId, direction: next.direction }));
  }, [setSortValue, sort]);

  const shell = useAuctionMarketShell({
    focused,
    width,
    height,
    selectedStateKey: "hkSelectedId",
    detailStateKey: "hkDetailOpen",
    stale,
    fetchedAt,
    loading,
    totalCount: tenders.length,
    rows,
    getId: hkTenderId,
    filter,
    setFilter,
    searchQuery,
    setSearchQuery,
    searchPlaceholder: ["paper, 10Y, issue, or date", "search"],
    marketFilter,
    reload: () => resource.reload(),
    autoLoad: resource.load,
    cycleSort,
  });

  const showYear = useMemo(() => auctionDatesShowYear(rows.map((tender) => tender.date)), [rows]);
  const columns = useMemo(() => buildHkColumns({ showYear, rows, width: width - 1 }), [rows, showYear, width]);
  const renderRow = useCallback((tender: HkTender, column: HkColumn, _index: number, rowState: { selected: boolean }) => (
    renderTenderCell(tender, column, rowState, showYear)
  ), [showYear]);

  const utcDay = useUtcDay();
  const board = resource.data;
  const info = useMemo(() => {
    const segments = loadingErrorFooterInfo(loading, error);
    // HKMA's terms ask for the credit; its figures lag the tenders, so the footer dates the newest listed,
    // as `fn AUCT HK` ends.
    if (board && tenders.length) {
      segments.push(reportFooterSegment(treasuryAuctionsHeadless,
        hkTendersReport(board, { search: searchQuery, filter, window: historyDays, view: "results", sort: null })));
    }
    if (savedAt != null) segments.push(...savedCopyFooterInfo([savedAt]));
    else if (stale) segments.push(STALE_SEGMENT);
    if (fetchedAt && savedAt == null) segments.push(ageFooterSegment(formatRelativeAge(fetchedAt)));
    return segments;
  }, [board, error, fetchedAt, filter, historyDays, loading, savedAt, searchQuery, stale, tenders.length, utcDay]);
  const toggleMarket = useCallback(() => marketFilter.onChange("us"), [marketFilter]);
  const hints = useMemo(() => shell.detailOpen || tenders.length === 0 ? [] : [
    { id: "search", key: "/", label: "search", onPress: shell.focusSearch },
    { id: "filter", key: "f", label: "ilter", onPress: shell.cycleFilter },
    ...auctionViewHints({ market: "hk", toggleMarket, cycleSort }),
  ], [shell.cycleFilter, cycleSort, shell.detailOpen, shell.focusSearch, tenders.length, toggleMarket]);
  // `o` opens HKMA's page for the dataset the selected tender came from.
  useExternalLinkFooter({
    registrationId: TREASURY_AUCTIONS_PANE_ID, focused: focused && !shell.searchFocused, url: shell.selected ? hkDatasetPage(shell.selected) : undefined, info, hints,
  });

  return (
    <AuctionMarketView
      width={width}
      height={height}
      focused={focused}
      loading={loading}
      error={error}
      totalCount={tenders.length}
      loadingLabel="Loading Hong Kong tenders..."
      unavailableTitle="Hong Kong tenders unavailable."
      shell={shell}
      columns={columns}
      rows={rows}
      getId={hkTenderId}
      sortColumnId={sort.columnId}
      sortDirection={sort.direction}
      onHeaderClick={(columnId) => setSortValue(writeHkSort(nextHeaderSort(sort, columnId as HkColumn["id"], { firstDirection: firstHkSortDirection })))}
      renderCell={renderRow}
      detailTitle={shell.selected ? `${hkTenderName(shell.selected)} ${hkTenderTerm(shell.selected)}` : undefined}
      detailContent={shell.selected ? <HkTenderDetail tender={shell.selected} width={width} /> : null}
      searchQuery={searchQuery}
      historyDays={historyDays}
      itemPlural="tenders"
      searchFields={HK_SEARCH_FIELDS}
    />
  );
}
