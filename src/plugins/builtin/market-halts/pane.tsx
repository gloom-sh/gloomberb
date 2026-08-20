import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DataTableView,
  EmptyState,
  Spinner,
  Tabs,
  type DataTableCell,
  type DataTableKeyEvent,
} from "../../../components";
import { useShortcut } from "../../../react/input";
import { colors } from "../../../theme/colors";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import type { PaneProps } from "../../../types/plugin";
import { Box, TextAttributes } from "../../../ui";
import { isPlainKey } from "../../../utils/keyboard";
import { cycleSortPreference } from "../../../utils/sort-values";
import { useConnectionHealth, usePluginTickerActions } from "../../runtime";
import { useAutoRefresh } from "../shared/auto-refresh";
import { usePaneStatusFooter } from "../shared/pane-footer";
import { acquireMarketHaltsHealth, fetchMarketHalts } from "./client";
import {
  DEFAULT_HALT_SORT,
  HALT_FILTERS,
  HALT_SORT_COLUMN_IDS,
  MARKET_HALTS_PANE_ID,
  buildHaltColumns,
  filterHalts,
  formatEtDate,
  formatEtResumption,
  formatEtTime,
  haltStatusColor,
  haltStatusLabel,
  nextHaltFilter,
  nextHaltSort,
  resolveHaltStatus,
  sortHalts,
  type HaltColumn,
  type HaltFilter,
  type HaltRecord,
  type HaltSortPreference,
} from "./model";

/** Halted rows flip to resumed on the clock alone, so the pane re-reads it. */
const STATUS_TICK_MS = 15_000;

export function MarketHaltsPane({ focused, width, height }: PaneProps) {
  const { pinTicker } = usePluginTickerActions();
  const connectionHealth = useConnectionHealth();
  const [records, setRecords] = useState<HaltRecord[]>([]);
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [filter, setFilter] = useState<HaltFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sortPreference, setSortPreference] = useState<HaltSortPreference>(DEFAULT_HALT_SORT);
  const [now, setNow] = useState(() => Date.now());
  const fetchGenRef = useRef(0);

  const load = useCallback(() => {
    fetchGenRef.current += 1;
    const generation = fetchGenRef.current;
    setStatus((current) => (current === "loaded" ? "loaded" : "loading"));
    setError(null);
    fetchMarketHalts(connectionHealth)
      .then((next) => {
        if (fetchGenRef.current !== generation) return;
        setRecords(next);
        setError(null);
        setStatus("loaded");
        setFetchedAt(Date.now());
        setNow(Date.now());
      })
      .catch((loadError: unknown) => {
        if (fetchGenRef.current !== generation) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        setStatus("error");
      });
  }, [connectionHealth]);

  useEffect(() => acquireMarketHaltsHealth(connectionHealth), [connectionHealth]);
  useEffect(() => { load(); }, [load]);
  useAutoRefresh(fetchedAt, load);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), STATUS_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const rows = useMemo(
    () => sortHalts(filterHalts(records, filter, now), sortPreference, now),
    [filter, now, records, sortPreference],
  );

  useEffect(() => {
    if (selectedId && rows.some((row) => row.id === selectedId)) return;
    setSelectedId(rows[0]?.id ?? null);
  }, [rows, selectedId]);

  const refresh = useCallback(() => load(), [load]);
  const cycleFilter = useCallback(() => setFilter((current) => nextHaltFilter(current)), []);
  const cycleSort = useCallback((step: 1 | -1) => {
    setSortPreference((current) => cycleSortPreference(HALT_SORT_COLUMN_IDS, current, step));
  }, []);
  const handleHeaderClick = useCallback((columnId: string) => {
    setSortPreference((current) => nextHaltSort(current, columnId));
  }, []);
  const openTicker = useCallback((record: HaltRecord) => {
    pinTicker(record.symbol, { floating: true, paneType: TICKER_RESEARCH_PANE_ID });
  }, [pinTicker]);

  const handlePaneKey = useCallback((event: DataTableKeyEvent): boolean => {
    if (isPlainKey(event, "r")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      refresh();
      return true;
    }
    if (isPlainKey(event, "f")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      cycleFilter();
      return true;
    }
    if (isPlainKey(event, "]", "[")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      cycleSort(event.name === "]" ? 1 : -1);
      return true;
    }
    return false;
  }, [cycleFilter, cycleSort, refresh]);

  useShortcut((event) => {
    if (event.targetEditable || event.defaultPrevented || event.propagationStopped) return;
    handlePaneKey(event as DataTableKeyEvent);
  }, { enabled: focused });

  const columns = useMemo(() => buildHaltColumns(width), [width]);

  usePaneStatusFooter({
    registrationId: MARKET_HALTS_PANE_ID,
    loading: status === "loading",
    error,
    hints: [{ id: "filter", key: "f", label: "ilter", onPress: cycleFilter }],
  });

  const renderCell = useCallback((
    row: HaltRecord,
    column: HaltColumn,
    _index: number,
    rowState: { selected: boolean },
  ): DataTableCell => {
    const selectedColor = rowState.selected ? colors.selectedText : undefined;
    switch (column.id) {
      case "symbol":
        return {
          text: row.symbol,
          color: selectedColor ?? colors.textBright,
          attributes: TextAttributes.BOLD,
        };
      case "market":
        return { text: row.market, color: selectedColor ?? colors.textDim };
      case "company":
        return { text: row.company, color: selectedColor ?? colors.text };
      case "code":
        return { text: row.reasonCode || "—", color: selectedColor ?? colors.textDim };
      case "reason":
        return { text: row.reason, color: selectedColor ?? colors.text };
      case "date":
        return { text: formatEtDate(row.haltedAt), color: selectedColor ?? colors.textMuted };
      case "halted":
        return { text: formatEtTime(row.haltedAt), color: selectedColor ?? colors.textMuted };
      case "quote":
        return {
          text: formatEtResumption(row.quoteResumeAt, row.haltedAt),
          color: selectedColor ?? colors.textDim,
        };
      case "trade":
        return {
          text: formatEtResumption(row.tradeResumeAt, row.haltedAt),
          color: selectedColor ?? colors.textDim,
        };
      case "status": {
        const rowStatus = resolveHaltStatus(row, now);
        return {
          text: haltStatusLabel(rowStatus),
          color: selectedColor ?? haltStatusColor(rowStatus),
          attributes: TextAttributes.BOLD,
        };
      }
    }
  }, [now]);

  const tabs = (
    <Box height={1} flexShrink={0} overflow="hidden">
      <Tabs
        tabs={HALT_FILTERS.map((entry) => ({ label: entry.label, value: entry.value }))}
        activeValue={filter}
        onSelect={(value) => setFilter(value as HaltFilter)}
        compact
        variant="bare"
        focused={focused}
        keyboardNavigation={false}
      />
    </Box>
  );

  if (status === "loading" && records.length === 0) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {tabs}
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <Spinner label="Loading trading halts..." />
        </Box>
      </Box>
    );
  }

  if (status === "error" && records.length === 0) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {tabs}
        <Box padding={1}>
          <EmptyState title="Trading halts unavailable." message={error ?? undefined} />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      {tabs}
      <DataTableView<HaltRecord, HaltColumn>
        focused={focused}
        rootWidth={width}
        rootHeight={Math.max(1, height - 1)}
        selection={{
          kind: "id",
          selectedId,
          getId: (row) => row.id,
          onChange: (id) => setSelectedId(id),
        }}
        onRootKeyDown={handlePaneKey}
        columns={columns}
        items={rows}
        sortColumnId={sortPreference.columnId}
        sortDirection={sortPreference.direction}
        onHeaderClick={handleHeaderClick}
        getItemKey={(row) => row.id}
        onActivate={openTicker}
        renderCell={renderCell}
        emptyStateTitle={filter === "all" ? "No trading halts reported." : "No halts match this filter."}
      />
    </Box>
  );
}
