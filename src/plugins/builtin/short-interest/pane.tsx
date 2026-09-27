import { useCallback, useEffect, useMemo, useState } from "react";
import {
  chartTableChromeRows,
  ChartTableHeader,
  DataTableView,
  EmptyState,
  Spinner,
  scalarPoint,
  staticSeries,
  unavailableText,
  useChartTableSelection,
  usePaneFooter,
  type DataTableCell,
} from "../../../components";
import { getTableWidth } from "../../../components/ui/table-layout";
import { useAsyncResource } from "../../../react/async-resource";
import { useShortcut } from "../../../react/input";
import { colors } from "../../../theme/colors";
import { Box, TextAttributes } from "../../../ui";
import { isPlainKey } from "../../../utils/keyboard";
import { isKnownNonUsEquityTicker } from "../../../utils/sec";
import { usePluginPaneState } from "../../runtime";
import { loadShortInterest } from "./client";
import {
  DEFAULT_SORT,
  buildColumns,
  buildRows,
  formatMaybeCompact,
  formatSharesAxis,
  nextSortPreference,
  shortInterestFigures,
  sortRows,
  type ShortInterestColumn,
  type ShortInterestRow,
  type SortPreference,
} from "./model";
import type { ShortInterestRecord } from "./types";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";

const EMPTY_RECORDS: ShortInterestRecord[] = [];
const rowKey = (row: ShortInterestRow) => row.key;
const rowDate = (row: ShortInterestRow) => row.record.settlementDate;

function ShortInterestView({ width, height, focused }: { width: number; height: number; focused: boolean }) {
  const { ticker } = usePaneTickerIdentity();
  const symbol = ticker?.metadata.ticker ?? null;

  const skipNonUs = isKnownNonUsEquityTicker(ticker);
  const request = useCallback(() => loadShortInterest(symbol!), [symbol]);
  const resource = useAsyncResource(symbol && !skipNonUs ? request : null, { clearOnError: true });
  const { error, updatedAt, reload: refresh } = resource;
  const records = resource.data?.records ?? EMPTY_RECORDS;
  const yahooFallback = resource.data?.source === "yahoo" && records.length > 0;
  const cloudSessionRequired = yahooFallback && resource.data?.cloudSessionRequired === true;
  const status = skipNonUs ? "loaded" : resource.status;
  const [sortPreference, setSortPreference] = usePluginPaneState<SortPreference>(
    "short-interest:sort",
    DEFAULT_SORT,
  );
  // Null follows the newest settlement, including after a reload.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  useEffect(() => { if (updatedAt !== null) setSelectedKey(null); }, [updatedAt]);

  const rows = useMemo(() => buildRows(records), [records]);
  const sortedRows = useMemo(() => sortRows(rows, sortPreference), [rows, sortPreference]);
  const columns = useMemo(() => buildColumns(records), [records]);
  // The header row, plus the scrollbar row once the columns overflow the pane.
  const tableChromeRows = chartTableChromeRows(columns, width);
  const effectiveKey = sortedRows.some((row) => row.key === selectedKey) ? selectedKey : sortedRows[0]?.key ?? null;
  const figures = useMemo(() => shortInterestFigures(records), [records]);
  // The legend reads the same as the SHARES SHORT column.
  const series = useMemo(() => [staticSeries(
    [...records]
      .sort((left, right) => left.settlementDate.getTime() - right.settlementDate.getTime())
      .map((record) => scalarPoint(record.settlementDate, record.sharesShort)),
    { id: "shares-short", label: "Shares short", color: colors.warning, calendarSpaced: true },
  )], [records]);
  const link = useChartTableSelection({
    rows: sortedRows, getId: rowKey, getDate: rowDate, selectedId: effectiveKey, onSelect: setSelectedKey, focused,
  });

  const handleHeaderClick = useCallback((columnId: string) => {
    setSortPreference((current) => nextSortPreference(current, columnId));
  }, [setSortPreference]);

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
      ...(yahooFallback ? [{
        id: "source",
        parts: [{
          text: cloudSessionRequired ? "latest 2 settlements, sign in for history" : "latest 2 settlements",
          tone: "warning" as const,
        }],
      }] : []),
    ],
  }), [cloudSessionRequired, error, status, yahooFallback]);

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
    const usEquitiesOnly = isKnownNonUsEquityTicker(ticker);
    return (
      <EmptyState
        title={usEquitiesOnly ? "US equities only" : "No short interest data"}
        message={usEquitiesOnly
          ? "Short interest data is available for US equities."
          : `No short interest found for ${symbol}.`}
      />
    );
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      <DataTableView<ShortInterestRow, ShortInterestColumn>
        focused={focused}
        selection={{ kind: "id", selectedId: effectiveKey, getId: rowKey, onChange: (id) => setSelectedKey(id) }}
        rootWidth={width}
        rootHeight={height}
        rootBefore={<ChartTableHeader width={width} height={height} tableRows={sortedRows.length} tableChromeRows={tableChromeRows}
          figures={figures} chart={{
          series, formatValue: formatMaybeCompact, formatAxisValue: formatSharesAxis, remoteKind: "short-interest-history", ...link,
        }} />}
        columns={columns}
        freezeFirstColumn
        items={sortedRows}
        sortColumnId={sortPreference.columnId}
        sortDirection={sortPreference.direction}
        onHeaderClick={handleHeaderClick}
        getItemKey={rowKey}
        renderCell={renderCell}
        emptyStateTitle={status === "loading" ? "Loading..." : "No data"}
      />
    </Box>
  );
}

export { ShortInterestView };
