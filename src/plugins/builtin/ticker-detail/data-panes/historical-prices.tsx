import { useCallback, useMemo } from "react";
import { TextAttributes } from "../../../../ui";
import {
  DataTableView,
  QueryBar,
  usePaneNoticeFooter,
  loadingText,
  unavailableText,
  usePaneFooter,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
} from "../../../../components";
import { TIME_RANGES, type TimeRange } from "../../../../time-series/range";
import type { PaneProps } from "../../../../types/plugin";
import type { PricePoint } from "../../../../types/financials";
import { colors, priceColor } from "../../../../theme/colors";
import { formatCompact, formatPercent } from "../../../../utils/format";
import { publicTickerKey } from "../../../../utils/exchanges";
import { formatPriceObservation, quoteFormatOptions } from "../../../../market-data/market/format";
import { cleanFloat32Price, historyPriceDecimals } from "../../../../cli/history-rows";
import { pricePointValues, priceHistoryIntegrityNotice } from "../../../../utils/price-history-integrity";
import {
  useAssetData,
  useDebouncedPluginPaneState,
  usePluginPaneState,
} from "../../../runtime";
import { usePaneTicker } from "../../../../state/app/context";
import { loadingErrorFooterInfo, useClampSelectedIndex } from "../../shared/table-pane";
import { formatDateTime, useBoundTicker, useTickerRequest } from "../../shared/ticker-request";

type HistoryColumnId = "date" | "open" | "high" | "low" | "close" | "change" | "changePercent" | "volume";
type HistoryColumn = DataTableColumn & { id: HistoryColumnId };

export type HistoricalPriceRow = {
  key: string;
  point: ReturnType<typeof pricePointValues>;
  date: string;
  change: number | null;
  changePercent: number | null;
};

function pricePointDate(point: PricePoint): Date | null {
  const value = point.date as Date | string | number;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** Every price in the table at one decimal count, so the columns line up. */
function formatMaybePrice(value: number | null | undefined, decimals: number, width: number): string {
  if (value == null || !Number.isFinite(value)) return "-";
  const rounded = Number(value.toFixed(Math.min(20, decimals)));
  return formatPriceObservation(rounded, { minimumFractionDigits: decimals, maxWidth: width });
}

/**
 * The decimals the table's prices need, by the same rule the CLI history
 * uses: capped by the asset's display rules (cents for a US equity) and read
 * from the float32-cleaned values so feed noise does not widen every row.
 */
function historicalPriceDecimals(rows: readonly HistoricalPriceRow[], assetCategory?: string): number {
  const clean = (value: number | null) => value == null ? null : cleanFloat32Price(value);
  return historyPriceDecimals(rows.flatMap(({ point }) => point.close == null ? [] : [{
    date: "",
    open: clean(point.open),
    high: clean(point.high),
    low: clean(point.low),
    close: clean(point.close)!,
    volume: point.volume,
  }]), assetCategory);
}

function formatMaybePercent(value: number | null): string {
  return value == null ? "-" : formatPercent(value);
}

function formatMaybeCompact(value: number | null | undefined): string {
  return value == null ? "-" : formatCompact(value);
}

export function buildHistoricalPriceRows(points: PricePoint[]): HistoricalPriceRow[] {
  const sorted = points
    .flatMap((point, sourceIndex) => {
      const date = pricePointDate(point);
      return date ? [{ point: pricePointValues(point), date, sourceIndex }] : [];
    })
    .sort((left, right) => left.date.getTime() - right.date.getTime());
  return sorted.map((entry, index) => {
    const previous = sorted[index - 1]?.point;
    const { point, date, sourceIndex } = entry;
    const change = previous?.close != null && point.close != null ? point.close - previous.close : null;
    return {
      key: `${date.toISOString()}:${sourceIndex}`,
      point,
      date: formatDateTime(date),
      change,
      changePercent: previous?.close && change !== null ? change / previous.close : null,
    };
  }).reverse();
}

const HISTORY_PRICE_WIDTH = 10;
const HISTORY_PERCENT_WIDTH = 9;
const HISTORY_NUMERIC_MIN_WIDTH = 8;
const HISTORY_VOLUME_WIDTH = 10;
/** Six numeric columns share any width left after the date and volume. */
const HISTORY_NUMERIC_IDS = ["open", "high", "low", "close", "change", "changePercent"] as const;

/**
 * Fixed date and volume columns; the price columns take the rest of the pane
 * evenly, and give up cells down to a floor when it is narrow, so the volume
 * stays on screen.
 */
function buildHistoryColumns(width: number, intraday: boolean): HistoryColumn[] {
  const dateWidth = intraday ? 16 : 10;
  const numeric: number[] = HISTORY_NUMERIC_IDS.map((id) => id === "changePercent" ? HISTORY_PERCENT_WIDTH : HISTORY_PRICE_WIDTH);
  // One gap per column plus the table's inset on both sides.
  const available = width - dateWidth - HISTORY_VOLUME_WIDTH - 8 - 2;
  let spare = available - numeric.reduce((sum, value) => sum + value, 0);
  for (let index = 0; spare < 0 && numeric.some((value) => value > HISTORY_NUMERIC_MIN_WIDTH); index = (index + 1) % numeric.length) {
    if (numeric[index]! > HISTORY_NUMERIC_MIN_WIDTH) {
      numeric[index]! -= 1;
      spare += 1;
    }
  }
  if (spare > 0) {
    const share = Math.floor(spare / numeric.length);
    numeric.forEach((value, index) => { numeric[index] = value + share + (index < spare % numeric.length ? 1 : 0); });
  }
  const [open, high, low, close, change, changePercent] = numeric as [number, number, number, number, number, number];
  return [
    { id: "date", label: intraday ? "DATE/TIME" : "DATE", width: dateWidth, align: "left" },
    { id: "open", label: "OPEN", width: open, align: "right", flexGrow: 1 },
    { id: "high", label: "HIGH", width: high, align: "right", flexGrow: 1 },
    { id: "low", label: "LOW", width: low, align: "right", flexGrow: 1 },
    { id: "close", label: "CLOSE", width: close, align: "right", flexGrow: 1 },
    { id: "change", label: "CHG", width: change, align: "right", flexGrow: 1 },
    { id: "changePercent", label: "CHG %", width: changePercent, align: "right", flexGrow: 1 },
    { id: "volume", label: "VOLUME", width: HISTORY_VOLUME_WIDTH, align: "right" },
  ];
}

const RANGE_OPTIONS = TIME_RANGES.map((range, index) => ({ label: range, value: range, hint: String(index + 1) }));

function nextHistoryRange(current: TimeRange): TimeRange {
  const index = TIME_RANGES.indexOf(current);
  return TIME_RANGES[(index + 1) % TIME_RANGES.length] ?? "1Y";
}

export function HistoricalPricesPane({ focused, width, height }: PaneProps) {
  const dataProvider = useAssetData();
  const { symbol, exchange, ticker } = useBoundTicker();
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
  const integrityNotice = priceHistoryIntegrityNotice(rows.filter((row) => row.point.integrity).length);
  // Daily and longer bars are dates; only intraday bars carry a time.
  const intraday = rows.length > 0 ? rows.some((row) => row.date.length > 10) : range === "1D" || range === "1W";
  const columns = useMemo(() => buildHistoryColumns(width, intraday), [intraday, width]);
  // The quote knows the instrument type even when the saved ticker does not;
  // resolve it the way every quote display does.
  const { financials } = usePaneTicker();
  const assetCategory = quoteFormatOptions(
    financials?.quote,
    ticker?.metadata.assetCategory,
    financials?.quoteMetadata?.instrumentType,
  ).assetCategory;
  const priceDecimals = useMemo(() => historicalPriceDecimals(rows, assetCategory), [assetCategory, rows]);
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
    const rangeIndex = /^[1-8]$/.test(event.name ?? "") ? Number(event.name) - 1 : -1;
    if (rangeIndex >= 0 && TIME_RANGES[rangeIndex]) {
      event.preventDefault?.();
      setRange(TIME_RANGES[rangeIndex]!);
      return true;
    }
    return false;
  }, [cycleRange, reload, setRange]);

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
        return { text: formatMaybePrice(row.point.open, priceDecimals, column.width), color: selectedColor ?? colors.text };
      case "high":
        return { text: formatMaybePrice(row.point.high, priceDecimals, column.width), color: selectedColor ?? colors.text };
      case "low":
        return { text: formatMaybePrice(row.point.low, priceDecimals, column.width), color: selectedColor ?? colors.text };
      case "close":
        return { text: formatMaybePrice(row.point.close, priceDecimals, column.width), color: selectedColor ?? colors.textBright, attributes: TextAttributes.BOLD };
      case "change":
        return { text: formatMaybePrice(row.change, priceDecimals, column.width), color: selectedColor ?? priceColor(row.change ?? 0) };
      case "changePercent":
        return { text: formatMaybePercent(row.changePercent), color: selectedColor ?? priceColor(row.changePercent ?? 0) };
      case "volume":
        return { text: formatMaybeCompact(row.point.volume), color: selectedColor ?? colors.textDim };
    }
  }, [priceDecimals]);

  // The range is picked in the query bar; t still steps through it.
  usePaneFooter("historical-prices", () => ({
    info: loadingErrorFooterInfo(loading, error),
  }), [error, loading]);

  usePaneNoticeFooter({
    registrationId: "historical-prices:integrity",
    notices: integrityNotice ? [integrityNotice] : [],
    focused,
    title: "Price history data",
  });

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
      getItemKey={(row) => row.key}
      rootBefore={(
        <QueryBar
          width={width}
          filters={[{
            id: "range",
            label: "Range",
            inline: true,
            value: range,
            options: RANGE_OPTIONS,
            onChange: (value: string) => setRange(value as TimeRange),
          }]}
        />
      )}
      renderCell={renderCell}
      getExportMetadata={() => [
        ["Ticker", symbol ? publicTickerKey(symbol, exchange) : ""],
        ["Requested range", range],
        ["Time zone", "UTC"],
        ["Price units", "As served in the history; currency and price-basis metadata are unavailable"],
        ["Status", error ? (rows.length ? "Retained after refresh failure" : "Unavailable")
          : loading ? (rows.length ? "Refreshing" : "Loading") : rows.length ? "Available" : "Empty"],
        ...(integrityNotice ? [["Warning", integrityNotice]] : []),
        ...(error ? [["Error", error]] : []),
      ]}
      emptyStateTitle={error
        ? unavailableText("Historical prices")
        : loading
          ? loadingText("historical prices")
          : "No historical prices"}
      emptyStateHint={error ?? undefined}
    />
  );
}
