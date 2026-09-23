import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  DataTableView,
  StatGrid,
  StaticChartSurface,
  statGridColumns,
  statGridRows,
  usePaneFooter,
  usePaneNoticeFooter,
  usePaneTicker,
  type DataTableCell,
  type DataTableKeyEvent,
  type StatItem,
} from "../../../components";
import type { ProjectedChartPoint } from "../../../components/chart/core/data";
import { resolveChartPalette } from "../../../components/chart/core/palette";
import { useAsyncResource } from "../../../react/async-resource";
import { colors, priceColor } from "../../../theme/colors";
import { Box, ScrollBox, TextAttributes, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import { displayWidth, formatCurrency, formatDistributionAmount, formatPercentRaw } from "../../../utils/format";
import { resolveCurrencyUnit } from "../../../utils/currency-units";
import { isPlainKeyboardEvent } from "../../../utils/keyboard";
import { handleRefreshKey, loadingErrorFooterInfo } from "../shared/table-pane";
import { SignInWall } from "../cloud/auth-actions";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { dividendReferencePrice, fetchDividendData, repriceDividendMetrics, type DividendData } from "./client";
import { useTickerQuoteStream } from "../../../state/hooks/live-ticker-financials";
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

/**
 * The dividend figures over the history chart. Labels stay short so a narrow
 * terminal does not clip them. The latest ex-date is the table's first row, so
 * it shows only when there is no table. Three columns read trailing, forward
 * and schedule down the band; two read trailing beside forward.
 */
function buildMetricItems(metrics: DividendMetrics, currency: string, hasHistory: boolean, columns: number): StatItem[] {
  const item = {
    ttmYield: { id: "ttm-yield", label: "TTM yield", value: formatDividendYield(metrics.trailingYield), color: priceColor(metrics.trailingYield ?? 0) },
    fwdYield: { id: "forward-yield", label: "Fwd yield", value: formatDividendYield(metrics.forwardYield), color: priceColor(metrics.forwardYield ?? 0) },
    ttmRate: { id: "ttm-rate", label: "TTM/share", value: formatRate(metrics.trailingRate, currency) },
    fwdRate: { id: "forward-rate", label: "Fwd/share", value: formatRate(metrics.forwardRate, currency) },
    growth1Y: { id: "growth-1y", label: "1Y growth", value: formatGrowth(metrics.growth1Y), color: priceColor(metrics.growth1Y ?? 0) },
    cagr3Y: { id: "cagr-3y", label: "3Y CAGR", value: formatGrowth(metrics.growth3Y), color: priceColor(metrics.growth3Y ?? 0) },
    payout: { id: "payout", label: "Payout", value: metrics.payoutRatio != null ? `${(metrics.payoutRatio * 100).toFixed(1)}%` : "—" },
    cadence: { id: "cadence", label: "Cadence", value: formatFrequency(metrics.paymentFrequency) },
    nextPay: { id: "next-pay", label: "Next pay", value: formatDate(metrics.nextPayDate) },
  } satisfies Record<string, StatItem>;
  const exDate: StatItem[] = metrics.nextExDividendDate
    ? [{ id: "next-ex", label: "Next ex", value: formatDate(metrics.nextExDividendDate) }]
    : hasHistory ? [] : [{ id: "last-ex", label: "Last ex", value: formatDate(metrics.lastExDividendDate) }];
  return columns === 3
    ? [item.ttmYield, item.fwdYield, item.payout, item.ttmRate, item.fwdRate, item.cadence, item.growth1Y, item.cagr3Y, item.nextPay, ...exDate]
    : [item.ttmYield, item.fwdYield, item.ttmRate, item.fwdRate, item.growth1Y, item.cagr3Y, item.payout, item.cadence, ...exDate, item.nextPay];
}

function DividendSummary({
  metrics,
  currency,
  hasHistory,
  width,
  height,
  chartPoints,
  scrollRef,
}: {
  metrics: DividendMetrics;
  currency: string;
  hasHistory: boolean;
  width: number;
  height: number;
  chartPoints: ProjectedChartPoint[];
  scrollRef: RefObject<ScrollBoxRenderable | null>;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  // Up to three columns, and in the terminal no more than the labels can
  // share: a label gets at most half its cell there.
  const sample = buildMetricItems(metrics, currency, hasHistory, 2);
  const labelChars = Math.max(...sample.map((item) => displayWidth(item.label)));
  const columns = Math.min(3, statGridColumns(sample, width),
    nativePaneChrome ? 3 : Math.max(1, Math.floor(width / (2 * (labelChars + 1) + 2))));
  const metricItems = columns === 3 ? buildMetricItems(metrics, currency, hasHistory, 3) : sample;
  const rowCount = statGridRows(metricItems, width, columns);
  const chartHeight = chartPoints.length >= 2 ? 6 : 0;
  // Keep the history header and three cash rows usable in a short pane.
  const summaryHeight = Math.min(rowCount + chartHeight, Math.max(1, height - 4));
  const palette = resolveChartPalette(colors, "positive");
  const axisDigits = cashAxisFractionDigits(chartPoints);

  return (
    <ScrollBox ref={scrollRef} scrollY focusable={false} height={summaryHeight} flexShrink={0}>
      <StatGrid items={metricItems} width={width} columns={columns} />
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
  // Yields are repriced from the quote on every render, so streaming it is all
  // it takes for them to move with the stock. A yield to two decimals needs
  // about one update a second, not the fast lane of a price on screen.
  useTickerQuoteStream(ticker ? symbol : null, ticker, { surface: "detail", visible: false, weight: 40 });
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
  const columns = useMemo(() => buildDividendColumns(), []);
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
          hasHistory={sortedRows.length > 0}
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
