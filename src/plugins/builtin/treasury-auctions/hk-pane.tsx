import { useCallback, useEffect, useMemo } from "react";
import type { HkTender } from "../../../api-client/hk-tenders";
import {
  DataTableStackView,
  EmptyState,
  KeyValueRow,
  PaneStatusBody,
  QueryBar,
  useExternalLinkFooter,
  usePaneMenuItems,
  usePaneTabs,
  useQueryBarSearch,
  type DataTableCell,
  type DataTableKeyEvent,
  type DataTableRootKeyContext,
  type QueryBarSelectFilter,
} from "../../../components";
import { loadingErrorFooterInfo, usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { ageFooterSegment, savedCopyFooterInfo } from "../../../components/layout/pane/footer";
import { STALE_SEGMENT } from "../../../components/layout/pane/status-footer";
import { useAsyncResource } from "../../../react/async-resource";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { colors } from "../../../theme/colors";
import { Box, ScrollBox, Text, TextAttributes } from "../../../ui";
import { formatRelativeAge, formatShortDate } from "../../../utils/datetime-format";
import { isPlainKey } from "../../../utils/keyboard";
import { isPlainArrowUp, stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";
import { cycleSortPreference, nextHeaderSort } from "../../../utils/sort-values";
import { usePluginPaneState } from "../../runtime";
import type { AuctionHistoryWindow } from "./client";
import {
  buildHkColumns,
  DEFAULT_HK_SORT,
  firstHkSortDirection,
  formatHkAmount,
  formatHkRate,
  HK_SEARCH_FIELDS,
  HK_SORT_COLUMN_IDS,
  hkAverage,
  hkHighest,
  hkSortColumn,
  hkSortName,
  hkTenderId,
  hkTenderName,
  hkTenderType,
  loadHkTenders,
  visibleHkTenders,
  hkWindowStart,
  type HkColumn,
  type HkSortPreference,
} from "./hk";
import {
  AUCTION_FILTERS,
  auctionDatesShowYear,
  auctionHistoryPhrase,
  nextAuctionHistoryWindow,
  nextFilter,
  type AuctionFilter,
} from "./model";
import { TREASURY_AUCTIONS_PANE_ID } from "./types";

const NO_TENDERS: HkTender[] = [];

/** A kept sort's name (`btc:asc`) as Hong Kong's columns read it; a US-only one is the default. */
function readHkSort(value: string | null): HkSortPreference {
  const [name, direction] = (value ?? "").split(":");
  const columnId = name ? hkSortColumn(name) : null;
  if (!columnId) return DEFAULT_HK_SORT;
  return { columnId, direction: direction === "asc" || direction === "desc" ? direction : firstHkSortDirection(columnId) };
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
      return {
        text: showYear ? tender.tenderDate : formatShortDate(tender.tenderDate, { year: false, utc: true, fallback: "\u2014" }),
        color: selected ?? colors.textDim,
      };
    case "type":
      return { text: hkTenderType(tender), color: typeColor(tender, rowState.selected), attributes: TextAttributes.BOLD };
    case "term":
      return { text: tender.term, color: selected ?? colors.text };
    case "rate":
      return { text: formatHkRate(tender, hkHighest(tender), "—"), color: selected ?? colors.textBright };
    case "average":
      return { text: formatHkRate(tender, hkAverage(tender), "—"), color: selected ?? colors.text };
    case "btc":
      return { text: tender.bidToCover == null ? "—" : tender.bidToCover.toFixed(2), color: selected ?? colors.text };
    case "size":
      return { text: formatHkAmount(tender, tender.allotted), color: selected ?? colors.textDim };
    case "cusip":
      return { text: tender.issue, color: selected ?? colors.textDim };
  }
}

const percent = (value: number | null) => value == null ? "—" : `${value.toFixed(3)}%`;
const price = (value: number | null) => value == null ? "—" : value.toFixed(2);

function HkTenderDetail({ tender, width }: { tender: HkTender; width: number }) {
  const row = (label: string, value: string) => (
    <KeyValueRow labelWidth={22} width={Math.max(1, width - 2)} emphasis={false} label={label} value={value} />
  );
  const spread = tender.highestYield == null && tender.highestSpread != null;
  return (
    <ScrollBox flexGrow={1} scrollY>
      <Box flexDirection="column" paddingX={1} width={width}>
        <Box flexDirection="row" height={1} gap={2}>
          <Text fg={colors.textDim}>{formatShortDate(tender.tenderDate, { utc: true, fallback: "\u2014" })}</Text>
          <Text fg={colors.textDim}>{tender.issue}</Text>
          {tender.stockCode && <Text fg={colors.textDim}>{`stock code ${tender.stockCode}`}</Text>}
          {tender.reopening && <Text fg={colors.textDim}>re-opening</Text>}
        </Box>
        <Box height={1} />
        {spread ? <>
          {row("Highest spread", formatHkRate(tender, hkHighest(tender), "—"))}
          {row("Average spread", formatHkRate(tender, hkAverage(tender), "—"))}
        </> : <>
          {row("Highest yield", percent(tender.highestYield))}
          {row("Average yield", percent(tender.averageYield))}
          {tender.lowestPrice != null && row("Lowest price", price(tender.lowestPrice))}
          {tender.averagePrice != null && row("Average price", price(tender.averagePrice))}
          {tender.averageTenderYield != null && row("Average tender yield", percent(tender.averageTenderYield))}
        </>}
        {row("Bid-to-cover", tender.bidToCover == null ? "—" : tender.bidToCover.toFixed(2))}
        {tender.proRata != null && row("Pro rata at highest", `${tender.proRata}%`)}
        <Box height={1} />
        {row("Applied", formatHkAmount(tender, tender.applied))}
        {row("Allotted", formatHkAmount(tender, tender.allotted))}
        {tender.coupon != null && row("Coupon", percent(tender.coupon))}
        {row("Issue date", tender.issueDate ?? "—")}
        {row("Maturity", tender.maturityDate ?? "—")}
      </Box>
    </ScrollBox>
  );
}

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

/** AUCT's Hong Kong market: HKMA's tender results for EF Bills and Notes and Government Bonds. */
export function HkTendersView({
  focused, width, height, historyDays, filter, setFilter, searchQuery, setSearchQuery, sortValue, setSortValue, marketFilter,
}: HkTendersViewProps) {
  const sort = useMemo(() => readHkSort(sortValue), [sortValue]);
  const loadTenders = useCallback((force: boolean) => loadHkTenders(force, historyDays), [historyDays]);
  const resource = useAsyncResource(loadTenders, { keepPreviousData: true });
  const tenders = resource.data?.tenders ?? NO_TENDERS;
  const stale = resource.data?.stale ?? false;
  const fetchedAt = resource.data?.fetchedAt ?? null;
  const savedAt = resource.data?.savedAt ?? null;
  const error = resource.error ?? (resource.loading || savedAt != null ? null : resource.data?.refreshError ?? null);
  const loading = resource.loading && !resource.data;
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("hkSelectedId", null);
  const [detailOpen, setDetailOpen] = usePluginPaneState<boolean>("hkDetailOpen", false);
  const { active: searchFocused, focus: focusSearch, blur: blurSearch, searchProps } = useQueryBarSearch();

  useAutoRefresh(stale ? null : fetchedAt, resource.load);
  usePaneRefreshKey(() => void resource.reload(), { focused, enabled: !searchFocused });

  const rows = useMemo(
    () => visibleHkTenders(tenders, { filter, query: searchQuery, sort, from: hkWindowStart(historyDays) }),
    [filter, historyDays, searchQuery, sort, tenders],
  );
  const selected = rows.find((tender) => hkTenderId(tender) === selectedId) ?? null;

  useEffect(() => {
    if (tenders.length === 0 && loading) return;
    if (rows.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      setDetailOpen(false);
      return;
    }
    if (!selectedId || !rows.some((tender) => hkTenderId(tender) === selectedId)) setSelectedId(hkTenderId(rows[0]!));
  }, [loading, rows, selectedId, tenders.length]);

  const cycleFilter = useCallback(() => {
    setFilter(nextFilter(filter));
    setDetailOpen(false);
  }, [filter, setFilter]);
  const cycleSort = useCallback((step: 1 | -1) => {
    const next = cycleSortPreference(HK_SORT_COLUMN_IDS, sort, step);
    setSortValue(writeHkSort({ columnId: next.columnId ?? DEFAULT_HK_SORT.columnId, direction: next.direction }));
  }, [setSortValue, sort]);

  const handlePaneKey = useCallback((event: DataTableKeyEvent): boolean => {
    if (isPlainKey(event, "f")) {
      stopSearchFocusNavigation(event);
      cycleFilter();
      return true;
    }
    if (isPlainKey(event, "]") || isPlainKey(event, "[")) {
      stopSearchFocusNavigation(event);
      cycleSort(event.name === "]" ? 1 : -1);
      return true;
    }
    return false;
  }, [cycleFilter, cycleSort]);
  const handleRootKeyDown = useCallback((event: DataTableKeyEvent, context: DataTableRootKeyContext) => {
    if (context.selectedIndex <= 0 && isPlainArrowUp(event)) {
      stopSearchFocusNavigation(event);
      focusSearch();
      return true;
    }
    return handlePaneKey(event);
  }, [focusSearch, handlePaneKey]);

  const showYear = auctionDatesShowYear(historyDays);
  const columns = useMemo(() => buildHkColumns({ showYear, rows, width: width - 1 }), [rows, showYear, width]);
  const renderRow = useCallback((tender: HkTender, column: HkColumn, _index: number, rowState: { selected: boolean }) => (
    renderTenderCell(tender, column, rowState, showYear)
  ), [showYear]);

  const info = useMemo(() => {
    const segments = loadingErrorFooterInfo(loading, error);
    if (savedAt != null) segments.push(...savedCopyFooterInfo([savedAt]));
    else if (stale) segments.push(STALE_SEGMENT);
    if (fetchedAt && savedAt == null) segments.push(ageFooterSegment(formatRelativeAge(fetchedAt)));
    return segments;
  }, [error, fetchedAt, loading, savedAt, stale]);
  const hints = useMemo(() => detailOpen || tenders.length === 0 ? [] : [
    { id: "search", key: "/", label: "search", onPress: focusSearch },
    { id: "filter", key: "f", label: "ilter", onPress: cycleFilter },
  ], [cycleFilter, detailOpen, focusSearch, tenders.length]);
  // `o` opens the selected tender's release on HKMA's site.
  useExternalLinkFooter({ registrationId: TREASURY_AUCTIONS_PANE_ID, focused: focused && !searchFocused, url: selected?.url, info, hints });

  usePaneMenuItems("treasury-auctions:sort-keys", () => detailOpen || tenders.length === 0 ? null : [
    { id: "sort-next", label: "Next Sort Column", accelerator: "]", onSelect: () => cycleSort(1) },
    { id: "sort-previous", label: "Previous Sort Column", accelerator: "[", onSelect: () => cycleSort(-1) },
  ], [tenders.length, cycleSort, detailOpen]);

  const filterTabs = useMemo(() => AUCTION_FILTERS.map((entry) => ({ label: entry.label, value: entry.value })), []);
  const { strip: tabStrip, rows: tabRows } = usePaneTabs({
    tabs: filterTabs,
    activeValue: filter,
    onSelect: (value) => {
      setFilter(value as AuctionFilter);
      setDetailOpen(false);
    },
    focused: focused && !detailOpen && !searchFocused,
    compact: true,
    variant: "bare",
  });
  const tabs = tabStrip && <Box height={1} flexShrink={0} overflow="hidden">{tabStrip}</Box>;
  const queryBar = (
    <QueryBar
      width={width}
      search={{
        value: searchQuery,
        onChange: setSearchQuery,
        placeholder: ["paper, 10Y, issue, or date", "search"],
        focused: focused && !detailOpen,
        ...searchProps,
      }}
      filters={[marketFilter]}
    />
  );

  if (loading && tenders.length === 0) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {tabs}
        {queryBar}
        <PaneStatusBody loading align="center" loadingLabel="Loading Hong Kong tenders..." />
      </Box>
    );
  }
  if (error && tenders.length === 0) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {tabs}
        {queryBar}
        <Box padding={1}>
          <EmptyState status="error" title="Hong Kong tenders unavailable." message={error} />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      {tabs}
      <DataTableStackView<HkTender, HkColumn>
        focused={focused && !searchFocused}
        detailOpen={detailOpen && !!selected}
        onBack={() => setDetailOpen(false)}
        detailContent={selected ? <HkTenderDetail tender={selected} width={width} /> : null}
        detailTitle={selected ? `${hkTenderName(selected)} ${selected.term}` : undefined}
        rootBefore={queryBar}
        onRootKeyDown={handleRootKeyDown}
        onDetailKeyDown={handlePaneKey}
        selection={{ kind: "id", selectedId, getId: hkTenderId, onChange: (id) => setSelectedId(id) }}
        onActivate={() => {
          blurSearch();
          setDetailOpen(true);
        }}
        rootWidth={width}
        rootHeight={Math.max(1, height - tabRows)}
        columns={columns}
        items={rows}
        sortColumnId={sort.columnId}
        sortDirection={sort.direction}
        onHeaderClick={(columnId) => setSortValue(writeHkSort(nextHeaderSort(sort, columnId as HkColumn["id"], { firstDirection: firstHkSortDirection })))}
        getItemKey={hkTenderId}
        renderCell={renderRow}
        emptyStateTitle={searchQuery.trim() ? "No matching tenders." : "No recent tenders."}
        emptyStateHint={`${searchQuery.trim() ? "Searched" : "Showing"} ${auctionHistoryPhrase(historyDays)}`
          + `${nextAuctionHistoryWindow(historyDays) ? "; older tenders are in the History window setting" : ""}. Search by ${HK_SEARCH_FIELDS}.`}
      />
    </Box>
  );
}
