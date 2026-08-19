import { useCallback, useMemo } from "react";
import { TextAttributes } from "../../../../ui";
import {
  DataTableView,
  loadingText,
  unavailableText,
  usePaneFooter,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
} from "../../../../components";
import type { TimeRange } from "../../../../components/chart/core/types";
import type { PaneProps } from "../../../../types/plugin";
import type { PricePoint } from "../../../../types/financials";
import { colors, priceColor } from "../../../../theme/colors";
import { formatCompact, formatNumber, formatPercent } from "../../../../utils/format";
import {
  useAssetData,
  useDebouncedPluginPaneState,
  usePluginPaneState,
} from "../../../runtime";
import { loadingErrorFooterInfo, useClampSelectedIndex } from "../../shared/table-pane";
import { formatDateTime, useBoundTicker, useTickerRequest } from "../../shared/ticker-request";

type HistoryColumnId = "date" | "open" | "high" | "low" | "close" | "change" | "changePercent" | "volume";
type HistoryColumn = DataTableColumn & { id: HistoryColumnId };

export type HistoricalPriceRow = {
  key: string;
  point: PricePoint;
  date: string;
  change: number | null;
  changePercent: number | null;
};

const HISTORY_RANGES: TimeRange[] = ["1D", "1W", "1M", "3M", "6M", "1Y", "5Y", "ALL"];

function pricePointDate(point: PricePoint): Date | null {
  const value = point.date as Date | string | number;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatMaybePrice(value: number | undefined): string {
  return value == null ? "-" : formatNumber(value, 2);
}

function formatMaybePercent(value: number | null): string {
  return value == null ? "-" : formatPercent(value);
}

function formatMaybeCompact(value: number | undefined): string {
  return value == null ? "-" : formatCompact(value);
}

export function buildHistoricalPriceRows(points: PricePoint[]): HistoricalPriceRow[] {
  const sorted = points
    .flatMap((point, sourceIndex) => {
      const date = pricePointDate(point);
      return date ? [{ point, date, sourceIndex }] : [];
    })
    .sort((left, right) => left.date.getTime() - right.date.getTime());
  return sorted.map((entry, index) => {
    const previous = sorted[index - 1]?.point;
    const { point, date, sourceIndex } = entry;
    const change = previous ? point.close - previous.close : null;
    return {
      key: `${date.toISOString()}:${sourceIndex}`,
      point,
      date: formatDateTime(date),
      change,
      changePercent: previous?.close ? change! / previous.close : null,
    };
  }).reverse();
}

function buildHistoryColumns(width: number): HistoryColumn[] {
  const dateWidth = 16;
  const priceWidth = 10;
  const changeWidth = 10;
  const percentWidth = 9;
  const volumeWidth = Math.max(9, width - 2 - dateWidth - priceWidth * 4 - changeWidth - percentWidth - 7);
  return [
    { id: "date", label: "DATE/TIME", width: dateWidth, align: "left" },
    { id: "open", label: "OPEN", width: priceWidth, align: "right" },
    { id: "high", label: "HIGH", width: priceWidth, align: "right" },
    { id: "low", label: "LOW", width: priceWidth, align: "right" },
    { id: "close", label: "CLOSE", width: priceWidth, align: "right" },
    { id: "change", label: "CHG", width: changeWidth, align: "right" },
    { id: "changePercent", label: "CHG %", width: percentWidth, align: "right" },
    { id: "volume", label: "VOLUME", width: volumeWidth, align: "right" },
  ];
}

function nextHistoryRange(current: TimeRange): TimeRange {
  const index = HISTORY_RANGES.indexOf(current);
  return HISTORY_RANGES[(index + 1) % HISTORY_RANGES.length] ?? "1Y";
}

export function HistoricalPricesPane({ focused, width, height }: PaneProps) {
  const dataProvider = useAssetData();
  const { symbol, exchange } = useBoundTicker();
  const [range, setRange] = usePluginPaneState<TimeRange>("range", "ALL");
  const [selectedIdx, setSelectedIdx] = useDebouncedPluginPaneState<number>("selectedIdx", 0);
  const loader = useCallback((nextSymbol: string, nextExchange: string, forceRefresh: boolean) => {
    if (!dataProvider) throw new Error("Market data unavailable");
    return dataProvider.getPriceHistory(
      nextSymbol,
      nextExchange,
      range,
      forceRefresh ? { cacheMode: "refresh" } : undefined,
    );
  }, [dataProvider, range]);
  const { data, loading, error, reload } = useTickerRequest<PricePoint[]>(loader, symbol, exchange);
  const rows = useMemo(() => buildHistoricalPriceRows(data ?? []), [data]);
  const columns = useMemo(() => buildHistoryColumns(width), [width]);
  const boundedSelectedIdx = rows.length > 0 ? Math.min(selectedIdx, rows.length - 1) : -1;
  const cycleRange = useCallback(() => setRange((current) => nextHistoryRange(current)), [setRange]);

  useClampSelectedIndex(rows.length, selectedIdx, setSelectedIdx);

  const handleKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (event.name === "r") {
      event.preventDefault?.();
      reload();
      return true;
    }
    if (event.name === "t") {
      event.preventDefault?.();
      cycleRange();
      return true;
    }
    return false;
  }, [cycleRange, reload]);

  const renderCell = useCallback((
    row: HistoricalPriceRow,
    column: HistoryColumn,
    _index: number,
    rowState: { selected: boolean },
  ): DataTableCell => {
    const selectedColor = rowState.selected ? colors.selectedText : undefined;
    switch (column.id) {
      case "date":
        return { text: row.date, color: selectedColor ?? colors.textDim };
      case "open":
        return { text: formatMaybePrice(row.point.open), color: selectedColor ?? colors.text };
      case "high":
        return { text: formatMaybePrice(row.point.high), color: selectedColor ?? colors.text };
      case "low":
        return { text: formatMaybePrice(row.point.low), color: selectedColor ?? colors.text };
      case "close":
        return { text: formatNumber(row.point.close, 2), color: selectedColor ?? colors.textBright, attributes: TextAttributes.BOLD };
      case "change":
        return { text: row.change == null ? "-" : formatNumber(row.change, 2), color: selectedColor ?? priceColor(row.change ?? 0) };
      case "changePercent":
        return { text: formatMaybePercent(row.changePercent), color: selectedColor ?? priceColor(row.changePercent ?? 0) };
      case "volume":
        return { text: formatMaybeCompact(row.point.volume), color: selectedColor ?? colors.textDim };
    }
  }, []);

  usePaneFooter("historical-prices", () => ({
    info: [
      { id: "range", parts: [{ text: range, tone: "muted" as const }] },
      ...loadingErrorFooterInfo(loading, error),
    ],
    hints: [
      { id: "range", key: "t", label: "oggle range", onPress: cycleRange },
    ],
  }), [cycleRange, error, loading, range]);

  return (
    <DataTableView<HistoricalPriceRow, HistoryColumn>
      focused={focused}
      selection={{
        kind: "index",
        selectedIndex: boundedSelectedIdx,
        onChange: (index) => setSelectedIdx(index),
      }}
      onRootKeyDown={handleKeyDown}
      rootWidth={width}
      rootHeight={height}
      columns={columns}
      items={rows}
      sortColumnId={null}
      sortDirection="desc"
      onHeaderClick={() => {}}
      getItemKey={(row) => row.key}
      renderCell={renderCell}
      emptyStateTitle={error
        ? unavailableText("Historical prices")
        : loading
          ? loadingText("historical prices")
          : "No historical prices"}
      emptyStateHint={error ?? undefined}
    />
  );
}
