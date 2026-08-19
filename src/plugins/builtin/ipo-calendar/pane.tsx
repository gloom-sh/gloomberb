import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  DataTableView,
  EmptyState,
  InputSearchBar,
  Spinner,
  useExternalLinkFooter,
  type DataTableCell,
  type DataTableKeyEvent,
} from "../../../components";
import { useShortcut } from "../../../react/input";
import { colors, priceColor } from "../../../theme/colors";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import type { PaneProps } from "../../../types/plugin";
import { Box, Text, TextAttributes, type InputRenderable } from "../../../ui";
import { isPlainKey } from "../../../utils/keyboard";
import { usePluginTickerActions } from "../../runtime";
import { useAutoRefresh } from "../shared/auto-refresh";
import { loadingErrorFooterInfo } from "../shared/table-pane";
import { getCachedIpoCalendar, loadIpoCalendar } from "./cache";
import {
  DEFAULT_SORT_PREFERENCE,
  buildColumns,
  formatDate,
  formatOfferSize,
  formatPrice,
  formatReturn,
  formatShares,
  matchesSearch,
  nextSortPreference,
  sortRows,
  statusColor,
  stockAnalysisUrl,
  type IPOColumn,
  type IPOSortPreference,
} from "./model";
import { IPO_CALENDAR_PANE_ID, type IPORecord, type LoadStatus } from "./types";

const SEARCH_DEBOUNCE_MS = 250;

export function IPOCalendarPane({ focused, width, height }: PaneProps) {
  const { pinTicker } = usePluginTickerActions();
  const [initialCache] = useState(getCachedIpoCalendar);
  const [records, setRecords] = useState<IPORecord[]>(initialCache?.records ?? []);
  // "idle" would render the empty state for one frame before the first load.
  const [status, setStatus] = useState<LoadStatus>(initialCache ? "loaded" : "loading");
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(initialCache?.stale ?? false);
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [sortPreference, setSortPreference] = useState<IPOSortPreference>(DEFAULT_SORT_PREFERENCE);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<number | null>(initialCache?.fetchedAt ?? null);
  const searchInputRef = useRef<InputRenderable | null>(null);
  const fetchGenRef = useRef(0);

  const load = useCallback(async (force = false) => {
    fetchGenRef.current += 1;
    const gen = fetchGenRef.current;
    setStatus((current) => (current === "loaded" ? current : "loading"));
    setError(null);

    try {
      const result = await loadIpoCalendar(force);
      if (fetchGenRef.current !== gen) return;
      setRecords(result.records);
      setStale(result.stale);
      setError(result.errors[0] ?? null);
      setStatus("loaded");
      setLastUpdated(result.fetchedAt);
    } catch (err) {
      if (fetchGenRef.current !== gen) return;
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The cache decides whether a tick becomes a scrape; only [r] forces it.
  useAutoRefresh(status === "loaded" && !stale ? lastUpdated : null, () => {
    void load();
  });

  const filtered = useMemo(
    () => records.filter((record) => matchesSearch(record, searchQuery)),
    [records, searchQuery],
  );

  const sorted = useMemo(
    () => sortRows(filtered, sortPreference),
    [filtered, sortPreference],
  );

  const columns = useMemo(() => buildColumns(width), [width]);

  useEffect(() => {
    if (selectedTicker && sorted.some((record) => record.ticker === selectedTicker)) return;
    const first = sorted[0];
    if (first) {
      setSelectedTicker(first.ticker);
    } else if (selectedTicker !== null) {
      setSelectedTicker(null);
    }
  }, [selectedTicker, sorted]);

  const loading = status === "loading" && records.length === 0;

  const focusSearch = useCallback(() => {
    setSearchFocused(true);
    setSearchFocusToken((token) => token + 1);
  }, []);

  const blurSearch = useCallback(() => {
    setSearchFocused(false);
  }, []);

  const updateSearch = useCallback((query: string) => {
    setSearchQuery(query);
    setSelectedTicker(null);
  }, []);

  const refresh = useCallback(() => {
    void load(true);
  }, [load]);

  const handleHeaderClick = useCallback((columnId: string) => {
    setSortPreference((current) => nextSortPreference(current, columnId));
  }, []);

  const handleTableKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (isPlainKey(event, "r")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      refresh();
      return true;
    }
    if (isPlainKey(event, "/")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      focusSearch();
      return true;
    }
    return false;
  }, [focusSearch, refresh]);

  const handleActivate = useCallback((record: IPORecord) => {
    pinTicker(record.ticker, { floating: true, paneType: TICKER_RESEARCH_PANE_ID });
  }, [pinTicker]);

  useShortcut((event) => {
    if (!focused || searchFocused) return;
    if (event.targetEditable) return;
    if (isPlainKey(event, "/")) {
      event.stopPropagation?.();
      event.preventDefault?.();
      focusSearch();
    } else if (isPlainKey(event, "r")) {
      event.stopPropagation?.();
      event.preventDefault?.();
      refresh();
    }
  }, { allowEditable: true, enabled: focused });

  const selectedRecord = useMemo(
    () => sorted.find((record) => record.ticker === selectedTicker) ?? null,
    [selectedTicker, sorted],
  );

  const footerInfo = useMemo(() => [
    ...loadingErrorFooterInfo(status === "loading", records.length === 0 ? error : null),
    // One endpoint failed while the other returned rows: say so without
    // spilling a scrape URL into the footer.
    ...(error && records.length > 0
      ? [{ id: "partial", parts: [{ text: "PARTIAL", tone: "warning" as const, bold: true }] }]
      : []),
    ...(stale ? [{ id: "stale", parts: [{ text: "STALE", tone: "warning" as const }] }] : []),
    ...(searchQuery ? [{
      id: "search",
      parts: [{ text: `filter: ${searchQuery}`, tone: "value" as const }],
    }] : []),
  ], [error, records.length, searchQuery, stale, status]);

  const footerHints = useMemo(
    () => [{ id: "search", key: "/", label: "search", onPress: focusSearch }],
    [focusSearch],
  );

  useExternalLinkFooter({
    registrationId: IPO_CALENDAR_PANE_ID,
    focused,
    url: selectedRecord ? stockAnalysisUrl(selectedRecord.ticker) : null,
    source: "stockanalysis.com",
    info: footerInfo,
    hints: footerHints,
  });

  const renderCell = useCallback(
    (row: IPORecord, column: IPOColumn, _index: number, rowState: { selected: boolean }): DataTableCell => {
      const selectedColor = rowState.selected ? colors.selectedText : undefined;

      switch (column.id) {
        case "ticker":
          return {
            text: row.ticker,
            color: selectedColor ?? colors.textBright,
            attributes: TextAttributes.BOLD,
          };
        case "company":
          return {
            text: row.companyName,
            color: selectedColor ?? colors.text,
          };
        case "date":
          return {
            text: formatDate(row.date),
            color: selectedColor ?? colors.textMuted,
          };
        case "status":
          return {
            text: row.status,
            color: selectedColor ?? statusColor(row.status),
          };
        case "exchange":
          return {
            text: row.exchange ?? "—",
            color: selectedColor ?? colors.textDim,
          };
        case "offer":
          return {
            text: formatOfferSize(row.offerSize),
            color: selectedColor ?? colors.textDim,
          };
        case "price":
          return {
            text: formatPrice(row),
            color: selectedColor ?? colors.text,
          };
        case "shares":
          return {
            text: formatShares(row.shares),
            color: selectedColor ?? colors.textDim,
          };
        case "return":
          return {
            text: formatReturn(row.change1D),
            color: selectedColor ?? (row.change1D != null ? priceColor(row.change1D) : colors.textDim),
          };
      }
    },
    [],
  );

  const rootBefore = (
    <InputSearchBar
      value={searchQuery}
      focused={focused}
      active={searchFocused}
      width={width}
      focusToken={searchFocusToken}
      inputRef={searchInputRef}
      placeholder="ticker, company, or exchange"
      debounceMs={SEARCH_DEBOUNCE_MS}
      normalizeValue={(value) => value.trim()}
      onFocus={focusSearch}
      onBlur={blurSearch}
      onNavigateDown={blurSearch}
      onQueryChange={updateSearch}
    />
  );

  if (loading) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {rootBefore}
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <Spinner label="Loading IPO calendar..." />
        </Box>
      </Box>
    );
  }

  if (status === "error" && records.length === 0) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {rootBefore}
        <Box padding={1} flexDirection="column" gap={1}>
          <EmptyState title="IPO calendar unavailable." message={error ?? undefined} />
        </Box>
      </Box>
    );
  }

  return (
    <DataTableView<IPORecord, IPOColumn>
      focused={focused && !searchFocused}
      rootBefore={rootBefore}
      rootWidth={width}
      rootHeight={height}
      selection={{
        kind: "id",
        selectedId: selectedTicker,
        getId: (row) => row.ticker,
        onChange: (ticker) => setSelectedTicker(ticker),
      }}
      onRootKeyDown={handleTableKeyDown}
      columns={columns}
      items={sorted}
      sortColumnId={sortPreference.columnId}
      sortDirection={sortPreference.direction}
      onHeaderClick={handleHeaderClick}
      getItemKey={(row) => row.ticker}
      onActivate={handleActivate}
      renderCell={renderCell}
      emptyStateTitle={
        searchQuery
          ? `No IPOs matching "${searchQuery}"`
          : status === "error"
            ? "Failed to load IPO data"
            : "No IPO data"
      }
    />
  );
}
