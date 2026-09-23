import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  DataTableView,
  KeyValueRow,
  StaticChartSurface,
  usePaneFooter,
  usePaneNoticeFooter,
  usePaneTicker,
  type DataTableCell,
  type DataTableKeyEvent,
} from "../../../components";
import type { ProjectedChartPoint } from "../../../components/chart/core/data";
import { resolveChartPalette } from "../../../components/chart/core/palette";
import { useAsyncResource } from "../../../react/async-resource";
import { colors, priceColor } from "../../../theme/colors";
import { Box, ScrollBox, Text, TextAttributes, type ScrollBoxRenderable } from "../../../ui";
import { formatCurrency, formatDistributionAmount, formatPercentRaw } from "../../../utils/format";
import { resolveCurrencyUnit } from "../../../utils/currency-units";
import { isPlainKeyboardEvent } from "../../../utils/keyboard";
import { handleRefreshKey, loadingErrorFooterInfo } from "../shared/table-pane";
import { SignInWall } from "../cloud/auth-actions";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { dividendReferencePrice, fetchDividendData, repriceDividendMetrics, type DividendData } from "./client";
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
import { dividendPriceAsOf, dividendPriceStatus, dividendQuotePriceMetadata } from "./reference-price";

function formatRate(value: number | null, currency: string): string {
  if (value == null) return "—";
  return formatDistributionAmount(value, currency);
}

/** Axis ticks are interpolated levels: size decimals to the tick spacing, not the six kept for payments. */
function cashAxisFractionDigits(points: readonly ProjectedChartPoint[]): number {
  const values = points.map((point) => point.close).filter(Number.isFinite);
  const range = values.length ? Math.max(...values) - Math.min(...values) : 0;
  const level = values.length ? Math.max(...values.map(Math.abs)) : 0;
  const spread = range > 0 ? range / 4 : level;
  if (!(spread > 0)) return 2;
  return Math.max(2, Math.min(6, Math.ceil(-Math.log10(spread))));
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
    metrics.nextExDividendDate
      ? { label: "Next Ex-Date", value: formatDate(metrics.nextExDividendDate) }
      : { label: "Last Ex-Date", value: formatDate(metrics.lastExDividendDate) },
    { label: "Next Pay", value: formatDate(metrics.nextPayDate) },
  ];
}

function renderMetricCell(row: MetricRow, width: number) {
  const rowWidth = Math.max(1, width - 1);
  const valueWidth = Math.min(rowWidth, Math.max(6, row.value.length));
  return (
    <KeyValueRow label={row.label} value={row.value.padStart(valueWidth)}
      width={rowWidth} labelWidth={rowWidth - valueWidth} color={row.color} emphasis={row.bold ?? false} />
  );
}

function DividendSummary({
  metrics,
  currency,
  width,
  height,
  chartPoints,
  scrollRef,
}: {
  metrics: DividendMetrics;
  currency: string;
  width: number;
  height: number;
  chartPoints: ProjectedChartPoint[];
  scrollRef: RefObject<ScrollBoxRenderable | null>;
}) {
  const metricRows = buildMetricRows(metrics, currency);
  const minColumnWidth = Math.max(...metricRows.map((row) => row.label.length + 2 + Math.max(6, row.value.length)));
  const columnCount = width - 2 >= minColumnWidth * 2 ? 2 : 1;
  const colWidth = Math.max(1, Math.floor((width - 2) / columnCount));
  const rowCount = Math.ceil(metricRows.length / columnCount);
  const chartHeight = chartPoints.length >= 2 ? 6 : 0;
  // Keep the history header and three cash rows usable in a short pane.
  const summaryHeight = Math.min(rowCount + chartHeight, Math.max(1, height - 4));
  const palette = resolveChartPalette(colors, "positive");
  const axisDigits = cashAxisFractionDigits(chartPoints);

  return (
    <ScrollBox ref={scrollRef} scrollY focusable={false} height={summaryHeight} flexShrink={0}>
      <Box flexDirection="column" paddingX={1} height={rowCount} flexShrink={0}>
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
      {chartPoints.length >= 2 && (
        <Box flexDirection="column" paddingX={1} height={chartHeight} flexShrink={0}>
          <StaticChartSurface
            points={chartPoints}
            width={Math.max(10, width - 2)}
            height={chartHeight}
            mode="step"
            calendarSpaced
            showTimeAxis
            colors={palette}
            yAxisLabel="TTM cash/share"
            yAxisColor={colors.textDim}
            formatYAxisValue={(value) => formatCurrency(value, currency, axisDigits)}
          />
        </Box>
      )}
    </ScrollBox>
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
  const cloudSession = useResearchCloudSession();
  const quoteCurrency = financials?.quote?.currency;
  const exchange = ticker?.metadata.exchange ?? "";
  const quotePrice = financials?.quote?.price ?? null;

  const [sortPreference, setSortPreference] = useState<DividendSortPreference>(DEFAULT_SORT_PREFERENCE);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const summaryScrollRef = useRef<ScrollBoxRenderable | null>(null);
  useEffect(() => { summaryScrollRef.current?.scrollTo(0); }, [symbol]);
  // Ten years of history must not be refetched on every live price tick, so the
  // quote is read through a ref instead of being an effect dependency.
  const quoteRef = useRef({ price: quotePrice, currency: quoteCurrency });
  quoteRef.current = { price: quotePrice, currency: quoteCurrency };

  const request = useCallback(() => loadData(symbol!, quoteRef.current.price, exchange, quoteRef.current.currency), [exchange, loadData, symbol, cloudSession.requestKey]);
  const { data, loading, error, updatedAt, reload: refresh } = useAsyncResource(symbol ? request : null);
  // An integrity response may contain no usable rows. Retain only historical
  // rows from this resource; its new unavailable metrics remain authoritative.
  const lastHistory = useRef<{ request: typeof request; data: DividendData } | null>(null);
  useEffect(() => {
    if (data && (data.historyAvailable !== false || data.payments.length > 0)) lastHistory.current = { request, data };
  }, [data, request]);
  const historyData = data?.historyError && data.payments.length === 0 && lastHistory.current?.request === request
    ? lastHistory.current.data : data;
  const authWall = !data && isCloudSessionRequired(error);
  useEffect(() => { if (updatedAt !== null) setSelectedIdx(0); }, [updatedAt]);

  const payments = historyData?.payments ?? [];
  const currency = data?.currency ?? payments[0]?.currency ?? resolveCurrencyUnit(ticker?.metadata.currency).currency;
  const paneReferencePrice = dividendReferencePrice(quotePrice, quoteCurrency, currency);
  const currentPrice = paneReferencePrice ?? data?.price ?? null;
  const priceMetadata = paneReferencePrice != null && financials?.quote
    ? dividendQuotePriceMetadata(financials.quote) : data;
  const priceAsOf = dividendPriceAsOf(Date.parse(priceMetadata?.priceAsOf ?? ""));
  const priceStatus = dividendPriceStatus(currentPrice, priceAsOf, priceMetadata?.priceStale);

  usePaneFooter("dividend-yield", () => {
    const active = loadingErrorFooterInfo(loading, authWall ? null : error ?? data?.historyError ?? data?.summaryError ?? null);
    if (active.length > 0) return { info: active };
    const priceText = priceStatus === "unknown-time" ? "Reference price time unavailable"
      : priceStatus === "stale" ? `Stale price${priceAsOf ? ` ${priceAsOf}` : ""}`
      : currentPrice != null && priceAsOf ? `Price ${priceAsOf}` : "";
    const historyText = historyData?.fetchedAt ? `History fetched ${historyData.fetchedAt}` : "";
    const showHistory = historyText && (!priceText || priceText.length + historyText.length + 3 <= width - 4);
    return { info: priceText || showHistory ? [{ id: "source-time", parts: [
      ...(priceText ? [{ text: priceText, tone: priceStatus ? "warning" as const : "muted" as const }] : []),
      ...(showHistory ? [{ text: `${priceText ? " · " : ""}${historyText}`, tone: "muted" as const }] : []),
    ] }] : [] };
  }, [authWall, currentPrice, historyData?.fetchedAt, data?.historyError, data?.summaryError, error, loading, priceAsOf, priceStatus, width]);

  const sourceWarnings = [
    ...(data?.stale ? ["Stale cash history; recent distributions may be missing."] : []),
  ];
  usePaneNoticeFooter({
    registrationId: "dividend-yield-notices",
    notices: sourceWarnings,
    focused,
    enabled: !authWall,
  });
  const metrics = data?.metrics ? repriceDividendMetrics(data.metrics, currentPrice) : undefined;
  const rows = useMemo(() => toDividendRows(payments), [payments]);
  const sortedRows = useMemo(() => sortRows(rows, sortPreference), [rows, sortPreference]);
  const columns = useMemo(() => buildDividendColumns(width), [width]);
  const chartPoints = useMemo(
    () => data?.historyAvailable === false ? [] : buildTrailingCashChartPoints(payments),
    [data?.historyAvailable, payments],
  );

  const handleHeaderClick = useCallback((columnId: string) => {
    setSortPreference((current) => nextSortPreference(current, columnId));
  }, []);

  const handleKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (isPlainKeyboardEvent(event) && (event.name === "pageup" || event.name === "pagedown")) {
      const summary = summaryScrollRef.current;
      const viewportHeight = summary?.viewport?.height ?? 0;
      const max = Math.max(0, (summary?.scrollHeight ?? 0) - viewportHeight);
      if (summary && max > 0) {
        const delta = Math.max(1, viewportHeight - 1) * (event.name === "pageup" ? -1 : 1);
        summary.scrollTo(Math.max(0, Math.min(max, summary.scrollTop + delta)));
        event.preventDefault?.();
        event.stopPropagation?.();
        return true;
      }
    }
    return handleRefreshKey(event, refresh, { stopPropagation: true });
  }, [refresh]);

  const emptyTitle = !symbol
    ? "No ticker selected."
    : loading
      ? "Loading dividends..."
      : error ?? (data?.historyAvailable ? "No cash distributions reported." : "Dividend history unavailable.");

  if (authWall) return <SignInWall action="view dividend history" needsVerification={cloudSession.needsVerification} />;

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
          height={height}
          chartPoints={chartPoints}
          scrollRef={summaryScrollRef}
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
