import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, TextAttributes, useUiCapabilities } from "../../../ui";
import {
  DataTableView,
  EmptyState,
  Spinner,
  StaticChartSurface,
  unavailableText,
  usePaneFooter,
  usePaneTicker,
  type DataTableCell,
  type DataTableKeyEvent,
} from "../../../components";
import { resolveChartPalette } from "../../../components/chart/core/palette";
import type { ProjectedChartPoint } from "../../../components/chart/core/data";
import { colors, blendHex } from "../../../theme/colors";
import { useShortcut } from "../../../react/input";
import { isPlainKey } from "../../../utils/keyboard";
import { formatCompact } from "../../../utils/format";
import { usePluginPaneState } from "../../runtime";
import { isUsEquityTicker } from "../../../utils/sec";
import type { TickerRecord } from "../../../types/ticker";
import { fetchShortInterest } from "./client";
import {
  buildColumns,
  buildRows,
  DEFAULT_SORT,
  nextSortPreference,
  sortRows,
  type ShortInterestColumn,
  type ShortInterestRow,
  type SortPreference,
} from "./model";
import type { LoadStatus, ShortInterestRecord } from "./types";

function hasClassifiableUsEquityMetadata(ticker: TickerRecord): boolean {
  const contract = ticker.metadata.broker_contracts?.[0];
  const currency = (contract?.currency ?? ticker.metadata.currency ?? "").trim();
  const type = (contract?.secType ?? ticker.metadata.assetCategory ?? "").trim();
  return currency.length > 0
    || type.length > 0
    || [contract?.primaryExchange, contract?.exchange, ticker.metadata.exchange]
      .some((value) => (value ?? "").trim().length > 0);
}

function recordsToChartPoints(records: ShortInterestRecord[]): ProjectedChartPoint[] {
  return records.map((record) => ({
    date: record.settlementDate,
    open: record.sharesShort,
    high: record.sharesShort,
    low: record.sharesShort,
    close: record.sharesShort,
    volume: 0,
  }));
}

function ShortInterestView({ width, height, focused }: { width: number; height: number; focused: boolean }) {
  const { nativePaneChrome } = useUiCapabilities();
  const { ticker } = usePaneTicker();
  const symbol = ticker?.metadata.ticker ?? null;

  const [records, setRecords] = useState<ShortInterestRecord[]>([]);
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sortPreference, setSortPreference] = usePluginPaneState<SortPreference>(
    "short-interest:sort",
    DEFAULT_SORT,
  );
  const [selectedIdx, setSelectedIdx] = useState(0);
  const fetchGenRef = useRef(0);

  const rows = useMemo(() => buildRows(records), [records]);
  const sortedRows = useMemo(() => sortRows(rows, sortPreference), [rows, sortPreference]);
  const columns = useMemo(() => buildColumns(width), [width]);
  const chartPoints = useMemo(() => recordsToChartPoints(records), [records]);

  const boundedSelectedIdx = sortedRows.length > 0
    ? Math.min(selectedIdx, sortedRows.length - 1)
    : -1;

  const skipNonUs = !!(ticker && hasClassifiableUsEquityMetadata(ticker) && !isUsEquityTicker(ticker));

  const loadData = useCallback(async () => {
    if (!symbol) {
      setRecords([]);
      setStatus("idle");
      setError(null);
      return;
    }
    if (skipNonUs) {
      setRecords([]);
      setStatus("loaded");
      setError(null);
      return;
    }

    fetchGenRef.current += 1;
    const gen = fetchGenRef.current;
    setStatus((current) => (current === "loaded" ? current : "loading"));
    setError(null);

    try {
      const data = await fetchShortInterest(symbol);
      if (fetchGenRef.current !== gen) return;
      setRecords(data);
      setStatus("loaded");
      setSelectedIdx(0);
    } catch (err) {
      if (fetchGenRef.current !== gen) return;
      setError(err instanceof Error ? err.message : String(err));
      setRecords([]);
      setStatus("error");
    }
  }, [skipNonUs, symbol]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const refresh = useCallback(() => {
    void loadData();
  }, [loadData]);

  const handleHeaderClick = useCallback((columnId: string) => {
    setSortPreference((current) => nextSortPreference(current, columnId));
  }, [setSortPreference]);

  const handleKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (event.name === "r") {
      event.preventDefault?.();
      event.stopPropagation?.();
      refresh();
      return true;
    }
    return false;
  }, [refresh]);

  useShortcut((event) => {
    if (!focused) return;
    if (isPlainKey(event, "r")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      refresh();
    }
  });

  const renderCell = useCallback((
    row: ShortInterestRow,
    column: ShortInterestColumn,
    _index: number,
    rowState: { selected: boolean },
  ): DataTableCell => {
    const selectedColor = rowState.selected ? colors.selectedText : undefined;
    switch (column.id) {
      case "settlementDate":
        return { text: row.settlementDate, color: selectedColor ?? colors.textDim };
      case "sharesShort":
        return { text: row.sharesShort, color: selectedColor ?? colors.textBright, attributes: TextAttributes.BOLD };
      case "shortRatio":
        return { text: row.shortRatio, color: selectedColor ?? colors.text };
      case "averageDailyVolume":
        return { text: row.averageDailyVolume, color: selectedColor ?? colors.textDim };
      case "shortPercentFloat":
        return { text: row.shortPercentFloat, color: selectedColor ?? colors.text };
    }
  }, []);

  usePaneFooter("short-interest", () => ({
    info: [
      ...(status === "loading" ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
      ...(status === "error" && error ? [{ id: "error", parts: [{ text: error.slice(0, 60), tone: "warning" as const }] }] : []),
    ],
  }), [error, status]);

  if (!ticker || !symbol) {
    return <EmptyState title="No ticker selected." message="Select a ticker to view short interest." />;
  }

  if ((status === "idle" || status === "loading") && records.length === 0) {
    return <Spinner label="Loading short interest..." />;
  }

  if (status === "error" && records.length === 0) {
    return <EmptyState title={unavailableText("Short interest")} message={error ?? undefined} />;
  }

  if (status === "loaded" && records.length === 0) {
    const usEquitiesOnly = hasClassifiableUsEquityMetadata(ticker) && !isUsEquityTicker(ticker);
    return (
      <EmptyState
        title={usEquitiesOnly ? "US equities only" : "No short interest data"}
        message={usEquitiesOnly
          ? "Short interest data is available for US equities."
          : `No short interest found for ${symbol}.`}
      />
    );
  }

  const showChart = chartPoints.length >= 2;
  const chartHeight = showChart ? Math.max(1, Math.floor((height - 1) * 0.35)) : 0;
  const tableHeight = Math.max(1, height - chartHeight - 1 - (nativePaneChrome ? 1 : 0));
  const chartWidth = Math.max(24, width - 2);
  const palette = {
    ...resolveChartPalette(colors, "neutral"),
    lineColor: colors.warning,
    fillColor: blendHex(colors.bg, colors.warning, 0.18),
    gridColor: blendHex(colors.bg, colors.border, 0.55),
  };

  return (
    <Box flexDirection="column" width={width} height={height}>
      {showChart ? (
        <Box flexDirection="column" marginTop={1} paddingX={1} flexShrink={0}>
          <StaticChartSurface
            points={chartPoints}
            width={chartWidth}
            height={chartHeight}
            mode="line"
            colors={palette}
            showTimeAxis
            timeAxisColor={colors.textDim}
            yAxisColor={colors.textDim}
            formatYAxisValue={(value: number) => formatCompact(value)}
          />
        </Box>
      ) : null}
      <Box flexGrow={1} marginTop={chartPoints.length >= 2 ? 1 : 0}>
        <DataTableView<ShortInterestRow, ShortInterestColumn>
          focused={focused}
          selection={{
            kind: "index",
            selectedIndex: boundedSelectedIdx,
            onChange: (index) => setSelectedIdx(index),
          }}
          onRootKeyDown={handleKeyDown}
          rootWidth={width}
          rootHeight={tableHeight}
          columns={columns}
          items={sortedRows}
          sortColumnId={sortPreference.columnId}
          sortDirection={sortPreference.direction}
          onHeaderClick={handleHeaderClick}
          getItemKey={(row) => row.key}
          renderCell={renderCell}
          emptyStateTitle={status === "loading" ? "Loading..." : "No data"}
        />
      </Box>
    </Box>
  );
}

export { ShortInterestView };
