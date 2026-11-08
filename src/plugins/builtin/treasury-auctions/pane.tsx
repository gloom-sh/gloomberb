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
  type QueryBarSelectFilter,
} from "../../../components";
import { loadingErrorFooterInfo, usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { ageFooterSegment, savedCopyFooterInfo } from "../../../components/layout/pane/footer";
import { STALE_SEGMENT } from "../../../components/layout/pane/status-footer";
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
import { useCommandValue } from "../shared/command-tab";
import { FIXED_INCOME_PANE_ID } from "../fixed-income/model";
import {
  afterLoadWindow, afterWindowStart, AUCTION_VIEWS, loadAuctionCurves, projectAuctionAfter, widerAfterWindow, type AuctionAfter, type AuctionView,
} from "./after";
import { loadTreasuryAuctions } from "./cache";
import type { AuctionHistoryWindow } from "./client";
import {
  AUCTION_AFTER_SORT_COLUMN_IDS,
  AUCTION_FILTERS,
  AUCTION_SEARCH_FIELDS,
  AUCTION_SORT_COLUMN_IDS,
  AUCTION_SORT_NAMES,
  DEFAULT_AUCTION_SORT,
  auctionDatesShowYear,
  auctionHistoryPhrase,
  auctionHistoryWindow,
  auctionSize,
  auctionSortColumn,
  buildAuctionColumns,
  dealerPct,
  directPct,
  firstAuctionSortDirection,
  formatAuctionRate,
  indirectPct,
  isAfterColumn,
  isBill,
  isPendingAuction,
  nextAuctionHistoryWindow,
  nextFilter,
  rateLabel,
  rateValue,
  middleRateLabel,
  publishesMedian,
  stopOutLabel,
  stopOutVsAvgBp,
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
import { AUCTION_MARKETS, isAuctionMarket, type AuctionMarket } from "./hk";
import { HkTendersView } from "./hk-pane";

function formatRate(value: number | null): string {
  return value == null ? "—" : `${value.toFixed(3)}%`;
}

/**
 * A metric a completed auction does not have is blank: Treasury's data has
 * bid-to-cover regularly from late 1999 and the bidder split only from
 * 2008-04-07. "—" stays for an announced auction whose results are not out yet.
 */
function formatRatio(value: number | null, auction?: TreasuryAuction): string {
  if (value == null) return auction && !isPendingAuction(auction) ? "" : "—";
  return value.toFixed(2);
}

function formatPct(value: number | null, auction?: TreasuryAuction): string {
  if (value == null) return auction && !isPendingAuction(auction) ? "" : "—";
  return `${value.toFixed(1)}%`;
}

/** The stop-out against the median reads in basis points, like an FRN margin. */
function formatBp(value: number | null): string {
  return value == null ? "—" : `${value.toFixed(1)}bp`;
}

/** A yield's move after the auction, in whole bp under a header that says bp; blank until the session is in. */
function formatMove(value: number | null): string {
  return value == null ? "" : `${value > 0 ? "+" : ""}${value.toFixed(0)}`;
}

const VIEW_OPTIONS = AUCTION_VIEWS.map((value) => ({ value, label: value === "after" ? "After" : "Results" }));

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

/** An announced auction's Rate in the table, the word other panes use for a figure not out yet (KPI's Later actual). */
const RESULTS_PENDING = "Pending";

// Stable table adapter so memoized rows survive pane re-renders.
const auctionKey = (auction: TreasuryAuction) => auction.id;

function renderAuctionCell(
  auction: TreasuryAuction,
  column: AuctionColumn,
  rowState: { selected: boolean },
  showYear: boolean,
  after: AuctionAfter | undefined,
): DataTableCell {
  const selected = rowState.selected ? colors.selectedText : undefined;
  const dimmed = selected ?? colors.textDim;

  switch (column.id) {
    case "date":
      // Announced auctions have no results yet: Rate reads Pending, the other
      // metric cells "—", and the date is bright.
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
      // An announced auction says its results are pending, as its detail does; other metric cells stay "—".
      return isPendingAuction(auction)
        ? { text: RESULTS_PENDING, color: dimmed }
        : { text: formatAuctionRate(auction, rateValue(auction), "—"), color: selected ?? colors.textBright };
    case "stopOut":
      return { text: formatBp(stopOutVsAvgBp(auction)), color: selected ?? colors.text };
    case "btc":
      return { text: formatRatio(auction.bidToCoverRatio, auction), color: selected ?? colors.text };
    case "indirect":
      return { text: formatPct(indirectPct(auction), auction), color: selected ?? colors.text };
    case "direct":
      return { text: formatPct(directPct(auction), auction), color: selected ?? colors.text };
    case "dealer":
      return { text: formatPct(dealerPct(auction), auction), color: selected ?? colors.text };
    case "size":
      return { text: formatMoney(auctionSize(auction)), color: dimmed };
    case "cusip":
      return { text: auction.cusip ?? "", color: dimmed };
    case "btcPctl":
    case "indirectPctl":
    case "dealerPctl": {
      const key = column.id === "btcPctl" ? "btcPercentile" : column.id === "indirectPctl" ? "indirectPercentile" : "dealerPercentile";
      const value = after?.[key] ?? null;
      return { text: value == null ? "" : String(value), value, color: selected ?? colors.text };
    }
    case "after1d":
    case "after5d":
    case "after20d": {
      const value = after?.[column.id] ?? null;
      return { text: formatMove(value), value, color: selected ?? colors.text };
    }
  }
}


function TreasuryAuctionDetail({ auction, width, after }: { auction: TreasuryAuction; width: number; after?: AuctionAfter }) {
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
        {isBill(auction) && auction.highDiscountRate != null && (
          <KeyValueRow labelWidth={22} width={Math.max(1, width - 2)} emphasis={false} label="High discount rate" value={formatRate(auction.highDiscountRate)} />
        )}
        {isBill(auction) && auction.avgMedDiscountRate != null && (
          <KeyValueRow labelWidth={22} width={Math.max(1, width - 2)} emphasis={false} label={middleRateLabel(auction, "discount rate")} value={formatRate(auction.avgMedDiscountRate)} />
        )}
        {auction.avgMedYield != null && (
          <KeyValueRow labelWidth={22} width={Math.max(1, width - 2)} emphasis={false} label={middleRateLabel(auction, "yield")} value={formatRate(auction.avgMedYield)} />
        )}
        {stopOutVsAvgBp(auction) != null && (
          <KeyValueRow labelWidth={22} width={Math.max(1, width - 2)} emphasis={false} label={stopOutLabel(auction)} value={formatBp(stopOutVsAvgBp(auction))} />
        )}
        <KeyValueRow labelWidth={22} width={Math.max(1, width - 2)} emphasis={false} label="Bid-to-cover" value={formatRatio(auction.bidToCoverRatio)} />
        <Box height={1} />
        <KeyValueRow labelWidth={22} width={Math.max(1, width - 2)} emphasis={false} label="High price" value={auction.highPrice?.toFixed(4) ?? "—"} />
        <KeyValueRow labelWidth={22} width={Math.max(1, width - 2)} emphasis={false} label={publishesMedian(auction) ? "Median price" : "Average price"} value={auction.avgMedPrice?.toFixed(4) ?? "—"} />
        <KeyValueRow labelWidth={22} width={Math.max(1, width - 2)} emphasis={false} label="Low price" value={auction.lowPrice?.toFixed(4) ?? "—"} />
        <Box height={1} />
        <KeyValueRow labelWidth={22} width={Math.max(1, width - 2)} emphasis={false} label="Offering" value={formatMoney(auction.offeringAmount)} />
        <KeyValueRow labelWidth={22} width={Math.max(1, width - 2)} emphasis={false} label="Total accepted" value={formatMoney(auction.totalAccepted)} />
        <KeyValueRow labelWidth={22} width={Math.max(1, width - 2)} emphasis={false} label="Competitive" value={share(auction.competitiveAccepted, auction.totalAccepted)} />
        <KeyValueRow labelWidth={22} width={Math.max(1, width - 2)} emphasis={false} label="Indirect" value={share(auction.indirectAccepted, auction.competitiveAccepted)} />
        <KeyValueRow labelWidth={22} width={Math.max(1, width - 2)} emphasis={false} label="Direct" value={share(auction.directAccepted, auction.competitiveAccepted)} />
        <KeyValueRow labelWidth={22} width={Math.max(1, width - 2)} emphasis={false} label="Primary dealer" value={share(auction.primaryDealerAccepted, auction.competitiveAccepted)} />
        {after && <>
          <Box height={1} />
          <KeyValueRow labelWidth={22} width={Math.max(1, width - 2)} emphasis={false} label="B/C percentile" value={after.btcPercentile == null ? "—" : String(after.btcPercentile)} />
          <KeyValueRow labelWidth={22} width={Math.max(1, width - 2)} emphasis={false} label="Indirect percentile" value={after.indirectPercentile == null ? "—" : String(after.indirectPercentile)} />
          <KeyValueRow labelWidth={22} width={Math.max(1, width - 2)} emphasis={false} label="Dealer percentile" value={after.dealerPercentile == null ? "—" : String(after.dealerPercentile)} />
          {after.cmt && ([[1, after.after1d], [5, after.after5d], [20, after.after20d]] as const).map(([sessions, value]) => (
            <KeyValueRow key={sessions} labelWidth={22} width={Math.max(1, width - 2)} emphasis={false}
              label={`${after.cmt} yield +${sessions}d`} value={value == null ? "—" : `${formatMove(value)}bp`} />
          ))}
        </>}
      </Box>
    </ScrollBox>
  );
}

const NO_AUCTIONS: TreasuryAuction[] = [];

/** A sort as kept in pane state and typed after --sort: the column's name, and `:asc` or `:desc` once the pane flips it. */
function readSort(value: string | null): AuctionSortPreference | null {
  if (!value) return null;
  const [name, direction] = value.split(":");
  const columnId = auctionSortColumn(name ?? "");
  if (!columnId) return null;
  return { columnId, direction: direction === "asc" || direction === "desc" ? direction : firstAuctionSortDirection(columnId) };
}

function writeSort(sort: AuctionSortPreference): string | null {
  const name = AUCTION_SORT_NAMES.find((entry) => entry.column === sort.columnId)?.value;
  return name ? `${name}:${sort.direction}` : null;
}

/** A command's value for this pane's auctions tab, from `AUCT 7Y --view after` and the like. */
const auctionParam = (key: string) => (params: Readonly<Record<string, string>>) => params.view === "auctions" ? params[key] ?? null : null;

/**
 * AUCT: US Treasury auctions, or Hong Kong's government paper tenders, by the
 * Market choice in the query bar (`AUCT --market hk`, `AUCT HK 10Y`). The
 * group, search, sort and window carry across.
 */
export function TreasuryAuctionsPane({ focused, width, height }: PaneProps) {
  const historyDays = auctionHistoryWindow(usePaneInstance()?.settings);
  const [marketChoice, setMarket] = useCommandValue<string>(FIXED_INCOME_PANE_ID, "market", auctionParam("auctionMarket"), "us");
  const market: AuctionMarket = isAuctionMarket(marketChoice) ? marketChoice : "us";
  const [sortValue, setSortValue] = useCommandValue<string | null>(FIXED_INCOME_PANE_ID, "sortColumn", auctionParam("auctionSort"), null);
  const [filter, setFilter] = useCommandValue<AuctionFilter>(FIXED_INCOME_PANE_ID, "activeTab",
    (params) => AUCTION_FILTERS.find((entry) => entry.value === auctionParam("auctionFilter")(params))?.value ?? null, "all");
  // `AUCT 10Y` opens on that search, as `fn AUCT 10Y` reads it; a later `AUCT 5Y` replaces it.
  const [searchQuery, setSearchQuery] = useCommandValue(
    FIXED_INCOME_PANE_ID,
    "search",
    (params) => params.view === "auctions" ? params.search ?? "" : null,
    "",
  );
  const marketFilter = useMemo<QueryBarSelectFilter<string>>(() => ({
    id: "market", label: "Market", value: market, options: AUCTION_MARKETS, onChange: setMarket, inline: true,
  }), [market, setMarket]);
  const shared = { focused, width, height, historyDays, filter, setFilter, searchQuery, setSearchQuery, sortValue, setSortValue, marketFilter };
  return market === "hk" ? <HkTendersView {...shared} /> : <UsAuctionsView {...shared} />;
}

function UsAuctionsView({
  focused, width, height, historyDays, filter, setFilter, searchQuery, setSearchQuery, sortValue, setSortValue, marketFilter,
}: Parameters<typeof HkTendersView>[0]) {
  const [viewChoice, setView] = useCommandValue<string>(FIXED_INCOME_PANE_ID, "view", auctionParam("auctionView"), "results");
  const sortPreference = useMemo(() => readSort(sortValue) ?? DEFAULT_AUCTION_SORT, [sortValue]);
  const setSortPreference = useCallback((next: AuctionSortPreference | ((current: AuctionSortPreference) => AuctionSortPreference)) => {
    setSortValue(writeSort(typeof next === "function" ? next(readSort(sortValue) ?? DEFAULT_AUCTION_SORT) : next));
  }, [setSortValue, sortValue]);
  // A sort by an after column shows the after view, as `fn AUCT --sort btc-pctl` does.
  const view: AuctionView = viewChoice === "after" || isAfterColumn(sortPreference.columnId) ? "after" : "results";
  // The after view reads more than it lists, until each listed tenor has its 24 before the oldest row
  // (widerAfterWindow); the widening holds for one list, and a new search, group or window starts over.
  const listKey = `${historyDays}|${filter}|${searchQuery}`;
  const [widened, setWidened] = useState<{ key: string; window: AuctionHistoryWindow } | null>(null);
  const loadWindow = view === "after"
    ? widened?.key === listKey ? widened.window : afterLoadWindow(historyDays)
    : historyDays;
  const loadAuctions = useCallback(
    (force: boolean) => loadTreasuryAuctions(force, undefined, loadWindow).then((result) => ({ ...result, window: loadWindow })),
    [loadWindow],
  );
  // A new history window keeps the loaded auctions up until its own answer.
  const resource = useAsyncResource(loadAuctions, { keepPreviousData: true });
  const auctions = resource.data?.auctions ?? NO_AUCTIONS;
  const stale = resource.data?.stale ?? false;
  const fetchedAt = resource.data?.fetchedAt ?? null;
  // A refresh that failed shows the auctions an earlier read saved, and says when that copy is from.
  const savedAt = resource.data?.savedAt ?? null;
  // A cache that could not be refreshed arrives as a result, not a failure.
  const error = resource.error ?? (resource.loading || savedAt != null ? null : resource.data?.refreshError ?? null);
  // Once auctions have loaded, a refresh runs without a loading state.
  const loading = resource.loading && !resource.data;
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selectedId", null);
  const [detailOpen, setDetailOpen] = usePluginPaneState<boolean>("detailOpen", false);
  const { active: searchFocused, focus: focusSearch, blur: blurSearch, searchProps } = useQueryBarSearch();

  // The cache decides whether a tick becomes a request; only [r] forces it.
  useAutoRefresh(stale ? null : fetchedAt, resource.load);

  const listed = useMemo(
    () => visibleAuctions(auctions, { filter, query: searchQuery, sort: DEFAULT_AUCTION_SORT,
      ...(view === "after" ? { from: afterWindowStart(historyDays) } : {}) }),
    [auctions, filter, historyDays, searchQuery, view],
  );
  const loadedWindow = resource.data?.window ?? null;
  useEffect(() => {
    if (view !== "after" || loadedWindow !== loadWindow) return;
    const wider = widerAfterWindow(listed, auctions, loadWindow);
    if (wider) setWidened({ key: listKey, window: wider });
  }, [auctions, listKey, listed, loadWindow, loadedWindow, view]);
  const curvesFrom = afterWindowStart(historyDays) ?? null;
  const loadCurves = useCallback(() => loadAuctionCurves(listed, curvesFrom), [curvesFrom, listed]);
  const curves = useAsyncResource(view === "after" ? loadCurves : null, { keepPreviousData: true });
  // Percentiles need only the board; the yield moves fill in when the curves arrive.
  const after = useMemo(() => view === "after" ? projectAuctionAfter(listed, auctions, curves.data?.curves ?? new Map()) : null,
    [auctions, curves.data, listed, view]);
  const yieldsError = view === "after" ? curves.error ?? curves.data?.errors[0] ?? null : null;
  const rows = useMemo(
    () => visibleAuctions(listed, { filter: "all", query: "", sort: sortPreference, ...(after ? { after } : {}) }),
    [after, listed, sortPreference],
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
  }, [setFilter]);
  const cycleFilter = useCallback(() => {
    setFilter(nextFilter(filter));
    setDetailOpen(false);
  }, [filter, setFilter]);
  const cycleSort = useCallback((step: 1 | -1) => {
    setSortPreference((current) => {
      const next = cycleSortPreference<AuctionColumnId>(view === "after" ? AUCTION_AFTER_SORT_COLUMN_IDS : AUCTION_SORT_COLUMN_IDS, current, step);
      return { columnId: next.columnId ?? DEFAULT_AUCTION_SORT.columnId, direction: next.direction };
    });
  }, [setSortPreference, view]);
  const selectView = useCallback((next: AuctionView) => {
    setView(next);
    // A sort the next view has no column for goes back to the newest first.
    const columns = next === "after" ? AUCTION_AFTER_SORT_COLUMN_IDS : AUCTION_SORT_COLUMN_IDS;
    if (!columns.includes(sortPreference.columnId)) setSortValue(null);
  }, [setSortValue, setView, sortPreference.columnId]);

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
  // A table that scrolls down keeps a cell for its scrollbar.
  const columns = useMemo(() => buildAuctionColumns({ showYear, view, rows, width: width - 1 }), [rows, showYear, view, width]);
  const renderAuctionRow = useCallback((
    auction: TreasuryAuction,
    column: AuctionColumn,
    _index: number,
    rowState: { selected: boolean },
  ) => renderAuctionCell(auction, column, rowState, showYear, after?.get(auction.id)), [after, showYear]);

  usePaneFooter(TREASURY_AUCTIONS_PANE_ID, () => {
    const info = loadingErrorFooterInfo(loading, error);
    if (yieldsError) info.push({ id: "yields", parts: [{ text: "Treasury yields unavailable", tone: "warning" as const }] });
    if (savedAt != null) info.push(...savedCopyFooterInfo([savedAt]));
    else if (stale) info.push(STALE_SEGMENT);
    if (fetchedAt && savedAt == null) {
      info.push(ageFooterSegment(formatRelativeAge(fetchedAt)));
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
    yieldsError,
    fetchedAt,
    focusSearch,
    loading,
    savedAt,
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
  const queryBar = (
    <QueryBar
      width={width}
      search={{
        value: searchQuery,
        onChange: setSearchQuery,
        placeholder: "type, 10Y, CUSIP, or date",
        focused: focused && !detailOpen,
        ...searchProps,
      }}
      filters={[marketFilter]}
      view={{ value: view, options: VIEW_OPTIONS, onChange: selectView }}
    />
  );

  if (loading && auctions.length === 0) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {tabs}
        {queryBar}
        <PaneStatusBody loading align="center" loadingLabel="Loading Treasury auctions..." />
      </Box>
    );
  }

  if (error && auctions.length === 0) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {tabs}
        {queryBar}
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
        detailContent={selected ? <TreasuryAuctionDetail auction={selected} width={width} after={after?.get(selected.id)} /> : null}
        detailTitle={selected ? `${selected.secType} ${selected.securityTerm}` : undefined}
        rootBefore={queryBar}
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
        emptyStateHint={`${searchQuery.trim() ? "Searched" : "Showing"} ${auctionHistoryPhrase(historyDays)}`
          + `${nextAuctionHistoryWindow(historyDays) ? "; older auctions are in the History window setting" : ""}. Search by ${AUCTION_SEARCH_FIELDS}.`}
      />
    </Box>
  );
}
