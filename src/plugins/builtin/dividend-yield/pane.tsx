import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DataTableView,
  Notice,
  StaticChartSurface,
  usePaneFooter,
  usePaneTicker,
  type DataTableCell,
  type DataTableKeyEvent,
} from "../../../components";
import type { ProjectedChartPoint } from "../../../components/chart/core/data";
import { resolveChartPalette } from "../../../components/chart/core/palette";
import { useAsyncResource } from "../../../react/async-resource";
import { colors, priceColor } from "../../../theme/colors";
import { Box, Text, TextAttributes } from "../../../ui";
import { formatDistributionAmount, formatPercentRaw } from "../../../utils/format";
import { resolveCurrencyUnit } from "../../../utils/currency-units";
import { handleRefreshKey, loadingErrorFooterInfo } from "../shared/table-pane";
import { dividendReferencePrice, fetchDividendData, repriceDividendMetrics } from "./client";
import { buildTrailingCashChartPoints, formatDividendYield } from "./view";
import {
  DEFAULT_SORT_PREFERENCE,
  buildDividendColumns,
  nextSortPreference,
  sortRows,
  toDividendRows,
  type DividendColumn,
  type DividendRow,
  type DividendSortPreference,
} from "./model";
import type { DividendMetrics } from "./types";

function formatRate(value: number | null, currency: string): string {
  if (value == null) return "—";
  return formatDistributionAmount(value, currency);
}

function formatGrowth(value: number | null): string {
  if (value == null) return "—";
  return formatPercentRaw(value * 100);
}

function formatDate(date: Date | null): string {
  if (!date) return "—";
  return date.toISOString().slice(0, 10);
}

function formatFrequency(freq: DividendMetrics["paymentFrequency"]): string {
  if (!freq) return "—";
  switch (freq) {
    case "monthly": return "Monthly";
    case "quarterly": return "Quarterly";
    case "semi-annual": return "Semi-Annual";
    case "annual": return "Annual";
    case "irregular": return "Irregular";
  }
}

interface MetricRow {
  label: string;
  value: string;
  color?: string;
  bold?: boolean;
}

function buildMetricRows(metrics: DividendMetrics, currency: string): MetricRow[] {
  return [
    { label: "TTM Cash Yield", value: formatDividendYield(metrics.trailingYield), color: priceColor(metrics.trailingYield ?? 0), bold: true },
    { label: "Forward Yield", value: formatDividendYield(metrics.forwardYield), color: priceColor(metrics.forwardYield ?? 0) },
    { label: "TTM Cash/Share", value: formatRate(metrics.trailingRate, currency) },
    { label: "Forward/Share", value: formatRate(metrics.forwardRate, currency) },
    { label: "1Y Cash Growth", value: formatGrowth(metrics.growth1Y), color: priceColor(metrics.growth1Y ?? 0) },
    { label: "3Y Cash CAGR", value: formatGrowth(metrics.growth3Y), color: priceColor(metrics.growth3Y ?? 0) },
    { label: "Earnings Payout", value: metrics.payoutRatio != null ? `${(metrics.payoutRatio * 100).toFixed(1)}%` : "—" },
    { label: "Recent Cadence", value: formatFrequency(metrics.paymentFrequency) },
    { label: "Ex-Dividend", value: formatDate(metrics.exDividendDate) },
    { label: "Next Pay", value: formatDate(metrics.nextPayDate) },
  ];
}

function renderMetricCell(row: MetricRow, width: number) {
  const valueWidth = Math.min(row.value.length, Math.max(6, width - 8));
  const labelWidth = Math.max(8, width - valueWidth - 1);
  return (
    <Box height={1} flexDirection="row">
      <Text fg={colors.textDim}>{row.label.slice(0, labelWidth).padEnd(labelWidth)}</Text>
      <Text
        fg={row.color ?? colors.text}
        attributes={row.bold ? TextAttributes.BOLD : undefined}
      >
        {row.value}
      </Text>
    </Box>
  );
}

const MIN_METRIC_COLUMN_WIDTH = 18;

function DividendSummary({
  metrics,
  currency,
  width,
  chartPoints,
  hasHistory,
  warnings,
}: {
  metrics: DividendMetrics;
  currency: string;
  width: number;
  chartPoints: ProjectedChartPoint[];
  hasHistory: boolean;
  warnings: string[];
}) {
  const metricRows = buildMetricRows(metrics, currency);
  // Two 18-cell blocks overflow anything narrower than 38 cells, so collapse.
  const columnCount = width - 2 >= MIN_METRIC_COLUMN_WIDTH * 2 ? 2 : 1;
  const colWidth = Math.max(MIN_METRIC_COLUMN_WIDTH, Math.floor((width - 2) / columnCount));
  const rowCount = Math.ceil(metricRows.length / columnCount);
  const chartHeight = chartPoints.length >= 2 ? 6 : 0;
  const palette = resolveChartPalette(colors, "positive");

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" paddingX={1} height={rowCount}>
        {Array.from({ length: rowCount }, (_, i) => {
          const left = metricRows[i * columnCount]!;
          const right = columnCount > 1 ? metricRows[i * columnCount + 1] : undefined;
          return (
            <Box key={left.label} height={1} flexDirection="row">
              <Box width={colWidth}>{renderMetricCell(left, colWidth)}</Box>
              {right ? <Box width={colWidth}>{renderMetricCell(right, colWidth)}</Box> : null}
            </Box>
          );
        })}
      </Box>
      {hasHistory && metrics.trailingRate === 0 ? (
        <Box paddingX={1}><Notice>No cash distributions reported in the past 12 months.</Notice></Box>
      ) : null}
      {warnings.map((warning) => <Box key={warning} paddingX={1}><Notice>{warning}</Notice></Box>)}
      {chartPoints.length >= 2 && (
        <Box flexDirection="column" paddingX={1} height={chartHeight}>
          <StaticChartSurface
            points={chartPoints}
            width={Math.max(10, width - 2)}
            height={chartHeight}
            mode="line"
            colors={palette}
            yAxisLabel="TTM cash/share"
            yAxisColor={colors.textDim}
            formatYAxisValue={(value) => formatRate(value, currency)}
          />
        </Box>
      )}
    </Box>
  );
}

function renderCell(
  row: DividendRow,
  column: DividendColumn,
  _index: number,
  rowState: { selected: boolean },
): DataTableCell {
  const selectedColor = rowState.selected ? colors.selectedText : undefined;
  switch (column.id) {
    case "exDate":
      return { text: row.exDate, color: selectedColor ?? colors.textDim };
    case "amount":
      return {
        text: formatDistributionAmount(row.amount, row.currency),
        color: selectedColor ?? colors.textBright,
        attributes: TextAttributes.BOLD,
      };
    case "currency":
      return { text: row.currency, color: selectedColor ?? colors.textDim };
  }
}

export function DividendYieldPane({ focused, width, height, loadData = fetchDividendData }: {
  focused: boolean; width: number; height: number; loadData?: typeof fetchDividendData;
}) {
  const { symbol, ticker, financials } = usePaneTicker();
  const quoteCurrency = financials?.quote?.currency;
  const exchange = ticker?.metadata.exchange ?? "";
  const quotePrice = financials?.quote?.price ?? null;

  const [sortPreference, setSortPreference] = useState<DividendSortPreference>(DEFAULT_SORT_PREFERENCE);
  const [selectedIdx, setSelectedIdx] = useState(0);
  // Ten years of history must not be refetched on every live price tick, so the
  // quote is read through a ref instead of being an effect dependency.
  const quoteRef = useRef({ price: quotePrice, currency: quoteCurrency });
  quoteRef.current = { price: quotePrice, currency: quoteCurrency };

  const request = useCallback(() => loadData(symbol!, quoteRef.current.price, exchange, quoteRef.current.currency), [exchange, loadData, symbol]);
  const { data, loading, error, updatedAt, reload: refresh } = useAsyncResource(symbol ? request : null);
  useEffect(() => { if (updatedAt !== null) setSelectedIdx(0); }, [updatedAt]);

  usePaneFooter("dividend-yield", () => ({
    info: [
      ...loadingErrorFooterInfo(loading, error),
      ...(data?.fetchedAt ? [{ id: "history-as-of", parts: [{
        text: `History fetched ${data.fetchedAt}`, tone: "muted" as const,
      }] }] : []),
    ],
  }), [data?.fetchedAt, error, loading]);

  const payments = data?.payments ?? [];
  const currency = data?.currency ?? payments[0]?.currency ?? resolveCurrencyUnit(ticker?.metadata.currency).currency;
  const paneReferencePrice = dividendReferencePrice(quotePrice, quoteCurrency, currency);
  const currentPrice = paneReferencePrice ?? data?.price ?? null;
  const referencePriceStale = paneReferencePrice != null ? financials?.quote?.stale : data?.priceStale;
  const sourceWarnings = [
    ...(data?.stale ? ["Stale cash history; recent distributions may be missing."] : []),
    ...(referencePriceStale ? ["Stale reference price; cash yield may be out of date."] : []),
  ];
  const metrics = data?.metrics ? repriceDividendMetrics(data.metrics, currentPrice) : undefined;
  const rows = useMemo(() => toDividendRows(payments), [payments]);
  const sortedRows = useMemo(() => sortRows(rows, sortPreference), [rows, sortPreference]);
  const columns = useMemo(() => buildDividendColumns(width), [width]);
  const chartPoints = useMemo(
    () => buildTrailingCashChartPoints(payments),
    [payments],
  );

  const handleHeaderClick = useCallback((columnId: string) => {
    setSortPreference((current) => nextSortPreference(current, columnId));
  }, []);

  const handleKeyDown = useCallback((event: DataTableKeyEvent) => {
    return handleRefreshKey(event, refresh, { stopPropagation: true });
  }, [refresh]);

  const emptyTitle = !symbol
    ? "No ticker selected."
    : loading
      ? "Loading dividends..."
      : error ?? (data?.historyAvailable ? "No cash distributions reported." : "Dividend history unavailable.");

  return (
    <DataTableView<DividendRow, DividendColumn>
      focused={focused}
      selection={{
        kind: "index",
        selectedIndex: sortedRows.length === 0 ? null : Math.min(selectedIdx, sortedRows.length - 1),
        onChange: (index) => setSelectedIdx(index),
      }}
      onRootKeyDown={handleKeyDown}
      resetScrollKey={symbol}
      rootWidth={width}
      rootHeight={height}
      rootBefore={metrics ? (
        <DividendSummary
          metrics={metrics}
          currency={currency}
          width={width}
          chartPoints={chartPoints}
          hasHistory={payments.length > 0}
          warnings={sourceWarnings}
        />
      ) : undefined}
      columns={columns}
      items={sortedRows}
      sortColumnId={sortPreference.columnId}
      sortDirection={sortPreference.direction}
      onHeaderClick={handleHeaderClick}
      getItemKey={(row) => row.key}
      renderCell={renderCell}
      emptyStateTitle={emptyTitle}
    />
  );
}
