import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DataTableStackView,
  EmptyState,
  InputSearchBar,
  Spinner,
  Tabs,
  usePaneFooter,
  type DataTableCell,
  type DataTableKeyEvent,
  type DataTableRootKeyContext,
  type PaneFooterSegment,
} from "../../../components";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, ScrollBox, Text, TextAttributes, type InputRenderable } from "../../../ui";
import { formatCompact } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
import { formatRelativeAge } from "../../../utils/relative-time";
import { isPlainArrowUp, stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";
import { cycleSortPreference } from "../../../utils/sort-values";
import { usePaneInstance } from "../../../state/app/context";
import { useAutoRefresh } from "../shared/auto-refresh";
import { loadTreasuryAuctions } from "./cache";
import {
  AUCTION_FILTERS,
  auctionHistoryDays,
  AUCTION_SORT_COLUMN_IDS,
  DEFAULT_AUCTION_SORT,
  buildAuctionColumns,
  indirectPct,
  isPendingAuction,
  auctionSize,
  nextAuctionSort,
  nextFilter,
  rateValue,
  visibleAuctions,
  type AuctionColumn,
  type AuctionColumnId,
  type AuctionFilter,
  type AuctionSortPreference,
} from "./model";
import {
  TREASURY_AUCTIONS_PANE_ID,
  type LoadStatus,
  type TreasuryAuction,
} from "./types";

function formatAuctionDate(value: string, withYear = false): string {
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) return "—";
  return new Date(timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: withYear ? "numeric" : undefined,
    timeZone: "UTC",
  });
}

function formatRate(value: number | null): string {
  return value == null ? "—" : `${value.toFixed(3)}%`;
}

function formatRatio(value: number | null): string {
  return value == null ? "—" : value.toFixed(2);
}

function formatPct(value: number | null): string {
  return value == null ? "—" : `${value.toFixed(1)}%`;
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

function renderAuctionCell(
  auction: TreasuryAuction,
  column: AuctionColumn,
  rowState: { selected: boolean },
): DataTableCell {
  const selected = rowState.selected ? colors.selectedText : undefined;
  const dimmed = selected ?? colors.textDim;

  switch (column.id) {
    case "date":
      // Announced auctions have no results yet; every metric cell reads "—",
      // so the date carries the distinction instead of a second placeholder.
      return {
        text: formatAuctionDate(auction.auctionDate),
        color: rowState.selected ? colors.selectedText : isPendingAuction(auction) ? colors.warning : colors.textDim,
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
      return { text: formatRate(rateValue(auction)), color: selected ?? colors.textBright };
    case "btc":
      return { text: formatRatio(auction.bidToCoverRatio), color: selected ?? colors.text };
    case "indirect":
      return { text: formatPct(indirectPct(auction)), color: selected ?? colors.text };
    case "size":
      return { text: formatMoney(auctionSize(auction)), color: dimmed };
  }
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <Box flexDirection="row" height={1} gap={2}>
      <Box width={20}>
        <Text fg={colors.textDim}>{label}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text fg={colors.textBright} wrapMode="ellipsis">{value}</Text>
      </Box>
    </Box>
  );
}

function TreasuryAuctionDetail({ auction, width }: { auction: TreasuryAuction; width: number }) {
  const total = auction.totalAccepted;
  const share = (value: number | null): string => (
    value == null || !total ? formatMoney(value) : `${formatMoney(value)} (${((value / total) * 100).toFixed(1)}%)`
  );

  return (
    <ScrollBox flexGrow={1} scrollY>
      <Box flexDirection="column" paddingX={1} width={width}>
        <Box flexDirection="row" height={1} gap={2}>
          <Text fg={colors.textDim}>{formatAuctionDate(auction.auctionDate, true)}</Text>
          {isPendingAuction(auction) && <Text fg={colors.warning}>results pending</Text>}
        </Box>
        <Box height={1} />
        <DetailRow label="High rate" value={formatRate(rateValue(auction))} />
        {auction.avgMedYield != null && (
          <DetailRow label="Median yield" value={formatRate(auction.avgMedYield)} />
        )}
        <DetailRow label="Bid-to-cover" value={formatRatio(auction.bidToCoverRatio)} />
        <Box height={1} />
        <DetailRow label="High price" value={auction.highPrice?.toFixed(4) ?? "—"} />
        <DetailRow label="Avg/median price" value={auction.avgMedPrice?.toFixed(4) ?? "—"} />
        <DetailRow label="Low price" value={auction.lowPrice?.toFixed(4) ?? "—"} />
        <Box height={1} />
        <DetailRow label="Offering" value={formatMoney(auction.offeringAmount)} />
        <DetailRow label="Total accepted" value={formatMoney(auction.totalAccepted)} />
        <DetailRow label="Competitive" value={share(auction.competitiveAccepted)} />
        <DetailRow label="Indirect" value={share(auction.indirectAccepted)} />
        <DetailRow label="Primary dealer" value={share(auction.primaryDealerAccepted)} />
      </Box>
    </ScrollBox>
  );
}

export function TreasuryAuctionsPane({ focused, width, height }: PaneProps) {
  const historyDays = auctionHistoryDays(usePaneInstance()?.settings);
  const [auctions, setAuctions] = useState<TreasuryAuction[]>([]);
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [filter, setFilter] = useState<AuctionFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [sortPreference, setSortPreference] = useState<AuctionSortPreference>(DEFAULT_AUCTION_SORT);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const searchInputRef = useRef<InputRenderable | null>(null);
  const fetchGenRef = useRef(0);

  const focusSearch = useCallback(() => {
    setSearchFocused(true);
    setSearchFocusToken((current) => current + 1);
  }, []);
  const blurSearch = useCallback(() => setSearchFocused(false), []);

  const load = useCallback((force = false) => {
    fetchGenRef.current += 1;
    const generation = fetchGenRef.current;
    setStatus((current) => (current === "loaded" ? "loaded" : "loading"));
    setError(null);
    loadTreasuryAuctions(force, undefined, historyDays)
      .then((result) => {
        if (fetchGenRef.current !== generation) return;
        setAuctions(result.auctions);
        setFetchedAt(result.fetchedAt);
        setStale(result.stale);
        setStatus("loaded");
      })
      .catch((loadError: unknown) => {
        if (fetchGenRef.current !== generation) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        setStatus("error");
      });
  }, [historyDays]);

  useEffect(() => { load(false); }, [load]);
  // The cache decides whether a tick becomes a request; only [r] forces it.
  const refresh = useCallback(() => load(false), [load]);
  useAutoRefresh(stale ? null : fetchedAt, refresh);

  const rows = useMemo(
    () => visibleAuctions(auctions, { filter, query: searchQuery, sort: sortPreference }),
    [auctions, filter, searchQuery, sortPreference],
  );
  const selected = rows.find((auction) => auction.id === selectedId) ?? null;

  useEffect(() => {
    if (rows.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      setDetailOpen(false);
      return;
    }
    if (!selectedId || !rows.some((auction) => auction.id === selectedId)) {
      setSelectedId(rows[0]!.id);
    }
  }, [rows, selectedId]);

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

  const handlePaneKey = useCallback((event: DataTableKeyEvent): boolean => {
    if (isPlainKey(event, "r")) {
      stopSearchFocusNavigation(event);
      load(true);
      return true;
    }
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
  }, [cycleFilter, cycleSort, load]);

  const handleRootKeyDown = useCallback((
    event: DataTableKeyEvent,
    context: DataTableRootKeyContext,
  ) => {
    if (context.selectedIndex <= 0 && isPlainArrowUp(event)) {
      stopSearchFocusNavigation(event);
      focusSearch();
      return true;
    }
    if (isPlainKey(event, "/")) {
      stopSearchFocusNavigation(event);
      focusSearch();
      return true;
    }
    return handlePaneKey(event);
  }, [focusSearch, handlePaneKey]);

  const columns = useMemo(() => buildAuctionColumns(width), [width]);
  const activeFilterLabel = AUCTION_FILTERS.find((entry) => entry.value === filter)?.label ?? "All";

  usePaneFooter(TREASURY_AUCTIONS_PANE_ID, () => {
    const info: PaneFooterSegment[] = [];
    if (status === "loading") info.push({ id: "loading", parts: [{ text: "loading", tone: "muted" }] });
    if (error) info.push({ id: "error", parts: [{ text: "error", tone: "warning" }] });
    if (stale) info.push({ id: "stale", parts: [{ text: "stale cache", tone: "warning" }] });
    if (filter !== "all") info.push({ id: "filter", parts: [{ text: activeFilterLabel, tone: "value" }] });
    if (searchQuery.trim()) {
      info.push({ id: "search", parts: [{ text: `search: ${searchQuery.trim()}`, tone: "value" }] });
    }
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
    activeFilterLabel,
    auctions.length,
    cycleFilter,
    detailOpen,
    error,
    fetchedAt,
    filter,
    focusSearch,
    searchQuery,
    stale,
    status,
  ]);

  const tabs = (
    <Box height={1} flexShrink={0} overflow="hidden">
      <Tabs
        tabs={AUCTION_FILTERS.map((entry) => ({ label: entry.label, value: entry.value }))}
        activeValue={filter}
        onSelect={(value) => selectFilter(value as AuctionFilter)}
        compact
        variant="bare"
        focused={focused && !detailOpen && !searchFocused}
      />
    </Box>
  );

  if (status === "loading" && auctions.length === 0) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {tabs}
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <Spinner label="Loading Treasury auctions..." />
        </Box>
      </Box>
    );
  }

  if (error && auctions.length === 0) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {tabs}
        <Box padding={1}>
          <EmptyState title="Treasury auctions unavailable." message={error} />
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
          <InputSearchBar
            value={searchQuery}
            focused={focused && !detailOpen}
            active={searchFocused}
            width={width}
            focusToken={searchFocusToken}
            inputRef={searchInputRef}
            placeholder="type, term, or date"
            debounceMs={80}
            onFocus={focusSearch}
            onBlur={blurSearch}
            onNavigateDown={blurSearch}
            onQueryChange={setSearchQuery}
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
        rootHeight={Math.max(1, height - 1)}
        columns={columns}
        items={rows}
        sortColumnId={sortPreference.columnId}
        sortDirection={sortPreference.direction}
        onHeaderClick={(columnId) => setSortPreference((current) => (
          nextAuctionSort(current, columnId as AuctionColumnId)
        ))}
        getItemKey={(auction) => auction.id}
        renderCell={(auction, column, _index, rowState) => renderAuctionCell(auction, column, rowState)}
        emptyStateTitle={searchQuery.trim() ? "No matching auctions." : "No recent auctions."}
        emptyStateHint={searchQuery.trim() ? "Clear search." : undefined}
      />
    </Box>
  );
}
