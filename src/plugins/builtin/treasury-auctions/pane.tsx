import { KeyValueRow } from "../../../components";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DataTableStackView,
  EmptyState,
  PaneStatusBody, QueryBar,
  usePaneFooter,
  usePaneMenuItems,
  usePaneTabs,
  useQueryBarSearch,
  type DataTableCell,
  type DataTableKeyEvent,
  type DataTableRootKeyContext,
} from "../../../components";
import { loadingErrorFooterInfo, usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { usePaneInstance } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, ScrollBox, Text, TextAttributes } from "../../../ui";
import { formatCompact } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
import { formatRelativeAge, formatShortDate } from "../../../utils/datetime-format";
import { isPlainArrowUp, stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";
import { cycleSortPreference, nextHeaderSort } from "../../../utils/sort-values";
import { usePluginPaneState } from "../../runtime";
import { useAsyncResource } from "../../../react/async-resource";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { loadTreasuryAuctions } from "./cache";
import {
  AUCTION_FILTERS,
  AUCTION_SEARCH_FIELDS,
  AUCTION_SORT_COLUMN_IDS,
  DEFAULT_AUCTION_SORT,
  auctionDatesShowYear,
  auctionHistoryDays,
  auctionHistoryPhrase,
  auctionSize,
  buildAuctionColumns,
  dealerPct,
  directPct,
  firstAuctionSortDirection,
  formatAuctionRate,
  indirectPct,
  isPendingAuction,
  nextFilter,
  rateLabel,
  rateValue,
  stopOutVsAverageBp,
  visibleAuctions,
  type AuctionColumn,
  type AuctionColumnId,
  type AuctionFilter,
  type AuctionSortPreference,
} from "./model";
import {
  TREASURY_AUCTIONS_PANE_ID,
  type TreasuryAuction,
} from "./types";

function formatRate(value: number | null): string {
  return value == null ? "—" : `${value.toFixed(3)}%`;
}

function formatRatio(value: number | null): string {
  return value == null ? "—" : value.toFixed(2);
}

function formatPct(value: number | null): string {
  return value == null ? "—" : `${value.toFixed(1)}%`;
}

/** The stop-out against the average reads in basis points, like an FRN margin. */
function formatBp(value: number | null): string {
  return value == null ? "—" : `${value.toFixed(1)}bp`;
}

function formatMoney(value: number | null): string {
  return value == null ? "—" : `$${formatCompact(value)}`;
}

function secTypeColor(secType: string, selected: boolean): string {
  if (selected) return colors.selectedText;
  switch (secType.toLowerCase()) {
    case "bill":
    case "cmb":
      return colors.positive;
    case "note":
    case "frn":
      return colors.textBright;
    case "bond":
    case "tips":
      return colors.warning;
    default:
      return colors.text;
  }
}

// Stable table adapter so memoized rows survive pane re-renders.
const auctionKey = (auction: TreasuryAuction) => auction.id;

function renderAuctionCell(
  auction: TreasuryAuction,
  column: AuctionColumn,
  rowState: { selected: boolean },
  showYear: boolean,
): DataTableCell {
  const selected = rowState.selected ? colors.selectedText : undefined;
  const dimmed = selected ?? colors.textDim;

  switch (column.id) {
    case "date":
      // Announced auctions have no results yet; every metric cell reads "—",
      // so the date carries the distinction instead of a second placeholder.
      return {
        text: showYear ? auction.auctionDate : formatShortDate(auction.auctionDate, { year: false, utc: true, fallback: "\u2014" }),
        color: rowState.selected ? colors.selectedText : isPendingAuction(auction) ? colors.textBright : colors.textDim,
      };
    case "type":
      return {
        text: auction.secType,
        color: secTypeColor(auction.secType, rowState.selected),
        attributes: TextAttributes.BOLD,
      };
    case "term":
      return { text: auction.securityTerm, color: selected ?? colors.text };
    case "rate":
      return { text: formatAuctionRate(auction, rateValue(auction), "—"), color: selected ?? colors.textBright };
    case "stopOut":
      return { text: formatBp(stopOutVsAverageBp(auction)), color: selected ?? colors.text };
    case "btc":
      return { text: formatRatio(auction.bidToCoverRatio), color: selected ?? colors.text };
    case "indirect":
      return { text: formatPct(indirectPct(auction)), color: selected ?? colors.text };
    case "direct":
      return { text: formatPct(directPct(auction)), color: selected ?? colors.text };
    case "dealer":
      return { text: formatPct(dealerPct(auction)), color: selected ?? colors.text };
    case "size":
      return { text: formatMoney(auctionSize(auction)), color: dimmed };
  }
}


function TreasuryAuctionDetail({ auction, width }: { auction: TreasuryAuction; width: number }) {
  const share = (value: number | null, total: number | null): string => (
    value == null || !total ? formatMoney(value) : `${formatMoney(value)} (${((value / total) * 100).toFixed(1)}%)`
  );

  return (
    <ScrollBox flexGrow={1} scrollY>
      <Box flexDirection="column" paddingX={1} width={width}>
        <Box flexDirection="row" height={1} gap={2}>
          <Text fg={colors.textDim}>{formatShortDate(auction.auctionDate, { utc: true, fallback: "\u2014" })}</Text>
          {isPendingAuction(auction) && <Text fg={colors.textDim}>results pending</Text>}
          {auction.cusip && <Text fg={colors.textDim}>{auction.cusip}</Text>}
        </Box>
        <Box height={1} />
        <KeyValueRow labelWidth={22} width={Math.max(1, width - 2)} emphasis={false} label={rateLabel(auction)} value={formatAuctionRate(auction, rateValue(auction), "—")} />
        {auction.avgMedYield != null && (
          <KeyValueRow labelWidth={22} width={Math.max(1, width - 2)} emphasis={false} label="Median yield" value={formatRate(auction.avgMedYield)} />
        )}
        {stopOutVsAverageBp(auction) != null && (
          <KeyValueRow labelWidth={22} width={Math.max(1, width - 2)} emphasis={false} label="Stop-out vs average" value={formatBp(stopOutVsAverageBp(auction))} />
        )}
        <KeyValueRow labelWidth={22} width={Math.max(1, width - 2)} emphasis={false} label="Bid-to-cover" value={formatRatio(auction.bidToCoverRatio)} />
        <Box height={1} />
        <KeyValueRow labelWidth={22} width={Math.max(1, width - 2)} emphasis={false} label="High price" value={auction.highPrice?.toFixed(4) ?? "—"} />
        <KeyValueRow labelWidth={22} width={Math.max(1, width - 2)} emphasis={false} label="Avg/median price" value={auction.avgMedPrice?.toFixed(4) ?? "—"} />
        <KeyValueRow labelWidth={22} width={Math.max(1, width - 2)} emphasis={false} label="Low price" value={auction.lowPrice?.toFixed(4) ?? "—"} />
        <Box height={1} />
        <KeyValueRow labelWidth={22} width={Math.max(1, width - 2)} emphasis={false} label="Offering" value={formatMoney(auction.offeringAmount)} />
        <KeyValueRow labelWidth={22} width={Math.max(1, width - 2)} emphasis={false} label="Total accepted" value={formatMoney(auction.totalAccepted)} />
        <KeyValueRow labelWidth={22} width={Math.max(1, width - 2)} emphasis={false} label="Competitive" value={share(auction.competitiveAccepted, auction.totalAccepted)} />
        <KeyValueRow labelWidth={22} width={Math.max(1, width - 2)} emphasis={false} label="Indirect" value={share(auction.indirectAccepted, auction.competitiveAccepted)} />
        <KeyValueRow labelWidth={22} width={Math.max(1, width - 2)} emphasis={false} label="Direct" value={share(auction.directAccepted, auction.competitiveAccepted)} />
        <KeyValueRow labelWidth={22} width={Math.max(1, width - 2)} emphasis={false} label="Primary dealer" value={share(auction.primaryDealerAccepted, auction.competitiveAccepted)} />
      </Box>
    </ScrollBox>
  );
}

const NO_AUCTIONS: TreasuryAuction[] = [];

export function TreasuryAuctionsPane({ focused, width, height }: PaneProps) {
  const historyDays = auctionHistoryDays(usePaneInstance()?.settings);
  const loadAuctions = useCallback(
    (force: boolean) => loadTreasuryAuctions(force, undefined, historyDays),
    [historyDays],
  );
  // A new history window keeps the loaded auctions up until its own answer.
  const resource = useAsyncResource(loadAuctions, { keepPreviousData: true });
  const auctions = resource.data?.auctions ?? NO_AUCTIONS;
  const stale = resource.data?.stale ?? false;
  const fetchedAt = resource.data?.fetchedAt ?? null;
  // A cache that could not be refreshed arrives as a result, not a failure.
  const error = resource.error ?? (resource.loading ? null : resource.data?.refreshError ?? null);
  // Once auctions have loaded, a refresh runs without a loading state.
  const loading = resource.loading && !resource.data;
  const [filter, setFilter] = usePluginPaneState<AuctionFilter>("activeTab", "all");
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selectedId", null);
  const [detailOpen, setDetailOpen] = usePluginPaneState<boolean>("detailOpen", false);
  const [sortPreference, setSortPreference] = useState<AuctionSortPreference>(DEFAULT_AUCTION_SORT);
  const [searchQuery, setSearchQuery] = useState("");
  const { active: searchFocused, focus: focusSearch, blur: blurSearch, searchProps } = useQueryBarSearch();

  // The cache decides whether a tick becomes a request; only [r] forces it.
  useAutoRefresh(stale ? null : fetchedAt, resource.load);

  const rows = useMemo(
    () => visibleAuctions(auctions, { filter, query: searchQuery, sort: sortPreference }),
    [auctions, filter, searchQuery, sortPreference],
  );
  const selected = rows.find((auction) => auction.id === selectedId) ?? null;

  useEffect(() => {
    // Before the first answer there is nothing to match a restored selection
    // against, so leave it alone rather than clear it.
    if (auctions.length === 0 && loading) return;
    if (rows.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      setDetailOpen(false);
      return;
    }
    if (!selectedId || !rows.some((auction) => auction.id === selectedId)) {
      setSelectedId(rows[0]!.id);
    }
  }, [auctions.length, loading, rows, selectedId]);

  const selectFilter = useCallback((next: AuctionFilter) => {
    setFilter(next);
    setDetailOpen(false);
  }, []);
  const cycleFilter = useCallback(() => {
    setFilter((current) => nextFilter(current));
    setDetailOpen(false);
  }, []);
  const cycleSort = useCallback((step: 1 | -1) => {
    setSortPreference((current) => {
      const next = cycleSortPreference<AuctionColumnId>(AUCTION_SORT_COLUMN_IDS, current, step);
      return { columnId: next.columnId ?? DEFAULT_AUCTION_SORT.columnId, direction: next.direction };
    });
  }, []);

  usePaneRefreshKey(() => void resource.reload(), { focused, enabled: !searchFocused });

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

  const handleRootKeyDown = useCallback((
    event: DataTableKeyEvent,
    context: DataTableRootKeyContext,
  ) => {
    if (context.selectedIndex <= 0 && isPlainArrowUp(event)) {
      stopSearchFocusNavigation(event);
      focusSearch();
      return true;
    }
    return handlePaneKey(event);
  }, [focusSearch, handlePaneKey]);

  const showYear = auctionDatesShowYear(historyDays);
  const columns = useMemo(() => buildAuctionColumns(showYear), [showYear]);
  const renderAuctionRow = useCallback((
    auction: TreasuryAuction,
    column: AuctionColumn,
    _index: number,
    rowState: { selected: boolean },
  ) => renderAuctionCell(auction, column, rowState, showYear), [showYear]);

  usePaneFooter(TREASURY_AUCTIONS_PANE_ID, () => {
    const info = loadingErrorFooterInfo(loading, error);
    if (stale) info.push({ id: "stale", parts: [{ text: "stale cache", tone: "warning" }] });
    if (fetchedAt) {
      info.push({ id: "updated", parts: [{ text: formatRelativeAge(fetchedAt), tone: "muted" }] });
    }
    return {
      info,
      hints: detailOpen || auctions.length === 0
        ? []
        : [
          { id: "search", key: "/", label: "search", onPress: focusSearch },
          { id: "filter", key: "f", label: "ilter", onPress: cycleFilter },
        ],
    };
  }, [
    auctions.length,
    cycleFilter,
    detailOpen,
    error,
    fetchedAt,
    focusSearch,
    loading,
    stale,
  ]);

  // The pane menu names the sort keys; "Sort by…" there picks a column directly.
  usePaneMenuItems("treasury-auctions:sort-keys", () => detailOpen || auctions.length === 0 ? null : [
    { id: "sort-next", label: "Next Sort Column", accelerator: "]", onSelect: () => cycleSort(1) },
    { id: "sort-previous", label: "Previous Sort Column", accelerator: "[", onSelect: () => cycleSort(-1) },
  ], [auctions.length, cycleSort, detailOpen]);

  const filterTabs = useMemo(
    () => AUCTION_FILTERS.map((entry) => ({ label: entry.label, value: entry.value })),
    [],
  );
  const { strip: tabStrip, rows: tabRows } = usePaneTabs({
    tabs: filterTabs,
    activeValue: filter,
    onSelect: (value) => selectFilter(value as AuctionFilter),
    focused: focused && !detailOpen && !searchFocused,
    compact: true,
    variant: "bare",
  });
  const tabs = tabStrip && <Box height={1} flexShrink={0} overflow="hidden">{tabStrip}</Box>;

  if (loading && auctions.length === 0) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {tabs}
        <PaneStatusBody loading align="center" loadingLabel="Loading Treasury auctions..." />
      </Box>
    );
  }

  if (error && auctions.length === 0) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {tabs}
        <Box padding={1}>
          <EmptyState status={error ? "error" : "empty"} title="Treasury auctions unavailable." message={error} />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      {tabs}
      <DataTableStackView<TreasuryAuction, AuctionColumn>
        focused={focused && !searchFocused}
        detailOpen={detailOpen && !!selected}
        onBack={() => setDetailOpen(false)}
        detailContent={selected ? <TreasuryAuctionDetail auction={selected} width={width} /> : null}
        detailTitle={selected ? `${selected.secType} ${selected.securityTerm}` : undefined}
        rootBefore={(
          <QueryBar
            width={width}
            search={{
              value: searchQuery,
              onChange: setSearchQuery,
              placeholder: "type, 10Y, CUSIP, or date",
              focused: focused && !detailOpen,
              ...searchProps,
            }}
          />
        )}
        onRootKeyDown={handleRootKeyDown}
        onDetailKeyDown={handlePaneKey}
        selection={{
          kind: "id",
          selectedId,
          getId: (auction) => auction.id,
          onChange: (id) => setSelectedId(id),
        }}
        onActivate={() => {
          blurSearch();
          setDetailOpen(true);
        }}
        rootWidth={width}
        rootHeight={Math.max(1, height - tabRows)}
        columns={columns}
        items={rows}
        sortColumnId={sortPreference.columnId}
        sortDirection={sortPreference.direction}
        onHeaderClick={(columnId) => setSortPreference((current) => (
          nextHeaderSort(current, columnId as AuctionColumnId, { firstDirection: firstAuctionSortDirection })
        ))}
        getItemKey={auctionKey}
        renderCell={renderAuctionRow}
        emptyStateTitle={searchQuery.trim() ? "No matching auctions." : "No recent auctions."}
        emptyStateHint={`${searchQuery.trim() ? "Searched" : "Showing"} ${auctionHistoryPhrase(historyDays)}; older auctions are in the History window setting. Search by ${AUCTION_SEARCH_FIELDS}.`}
      />
    </Box>
  );
}
