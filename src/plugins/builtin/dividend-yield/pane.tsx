import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  chartTableChromeRows,
  ChartTableHeader,
  chartTableLayout,
  DataTableView,
  scalarPoint,
  spanAxisFormatter,
  statGridColumns,
  staticSeries,
  useChartTableSelection,
  usePaneFooter,
  usePaneNoticeFooter,
  usePaneTicker,
  type DataTableCell,
  type DataTableKeyEvent,
  type StatItem,
} from "../../../components";
import { useAsyncResource } from "../../../react/async-resource";
import { colors, priceColor } from "../../../theme/colors";
import { TextAttributes, useUiCapabilities } from "../../../ui";
import { displayWidth, formatCurrency, formatDistributionAmount, formatPercentRaw } from "../../../utils/format";
import { resolveCurrencyUnit } from "../../../utils/currency-units";
import { nextHeaderSort } from "../../../utils/sort-values";
import { handleRefreshKey, loadingErrorFooterInfo } from "../../../components/data-table/table-pane";
import { SignInWall } from "../cloud/auth-actions";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { dividendReferencePrice, fetchDividendData, repriceDividendMetrics, type DividendData } from "./client";
import { useTickerQuoteStream } from "../../../state/hooks/live-ticker-financials";
import { buildTrailingCashChartPoints, formatDividendYield, toDividendRows, type DividendRow } from "./view";
import {
  DEFAULT_SORT_PREFERENCE,
  buildDividendColumns,
  sortRows,
  type DividendColumn,
  type DividendColumnId,
  type DividendSortPreference,
} from "./model";
import type { DividendMetrics } from "./types";
import { dividendPriceAsOf, dividendPriceStatus, dividendQuotePriceMetadata } from "./reference-price";

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

/**
 * The dividend figures over the history chart, most important first so a
 * short pane keeps the yields. Labels stay short so a narrow terminal does not
 * clip them. The latest ex-date is the table's first row, so it shows only
 * when there is no table.
 */
function buildMetricItems(metrics: DividendMetrics, currency: string, hasHistory: boolean, short: boolean): StatItem[] {
  const exDate: StatItem[] = metrics.nextExDividendDate
    ? [{ id: "next-ex", label: "Next ex", value: formatDate(metrics.nextExDividendDate) }]
    : hasHistory ? [] : [{ id: "last-ex", label: "Last ex", value: formatDate(metrics.lastExDividendDate) }];
  return [
    { id: "ttm-yield", label: short ? "TTM yld" : "TTM yield", value: formatDividendYield(metrics.trailingYield), color: priceColor(metrics.trailingYield ?? 0) },
    { id: "forward-yield", label: short ? "Fwd yld" : "Fwd yield", value: formatDividendYield(metrics.forwardYield), color: priceColor(metrics.forwardYield ?? 0) },
    { id: "ttm-rate", label: short ? "TTM/sh" : "TTM/share", value: formatRate(metrics.trailingRate, currency) },
    { id: "forward-rate", label: short ? "Fwd/sh" : "Fwd/share", value: formatRate(metrics.forwardRate, currency) },
    { id: "growth-1y", label: short ? "1Y chg" : "1Y growth", value: formatGrowth(metrics.growth1Y), color: priceColor(metrics.growth1Y ?? 0) },
    { id: "cagr-3y", label: "3Y CAGR", value: formatGrowth(metrics.growth3Y), color: priceColor(metrics.growth3Y ?? 0) },
    { id: "payout", label: "Payout", value: metrics.payoutRatio != null ? `${(metrics.payoutRatio * 100).toFixed(1)}%` : "—" },
    { id: "cadence", label: "Cadence", value: formatFrequency(metrics.paymentFrequency) },
    ...exDate,
    { id: "next-pay", label: "Next pay", value: formatDate(metrics.nextPayDate) },
  ];
}

/**
 * The terminal grid gives a label at most half its cell; where the figures the
 * kit keeps come out in columns narrower than that, the labels would clip.
 */
function labelsClip(items: readonly StatItem[], width: number): boolean {
  if (items.length < 2) return false;
  const columns = statGridColumns([...items], width);
  const cell = Math.floor((width - 2 - 2 * (columns - 1)) / columns);
  const labels = Math.max(...items.map((item) => displayWidth(item.label)));
  return Math.floor(cell / 2) < labels + 1;
}

const rowKey = (row: DividendRow) => row.key;

function renderCell(
  row: DividendRow,
  column: DividendColumn,
): DataTableCell {
  switch (column.id) {
    case "exDate":
      return { text: row.exDate, color: colors.textDim };
    case "amount":
      return {
        text: formatDistributionAmount(row.amount, row.currency),
        color: colors.textBright,
        attributes: TextAttributes.BOLD,
      };
    case "currency":
      return { text: row.currency, color: colors.textDim };
  }
}

export function DividendYieldPane({ focused, width, height, loadData = fetchDividendData }: {
  focused: boolean; width: number; height: number; loadData?: typeof fetchDividendData;
}) {
  const { symbol, ticker, financials } = usePaneTicker();
  const { nativePaneChrome } = useUiCapabilities();
  // Yields are repriced from the quote on every render, so streaming it is all
  // it takes for them to move with the stock. A yield to two decimals needs
  // about one update a second, not the fast lane of a price on screen.
  useTickerQuoteStream(ticker ? symbol : null, ticker, { surface: "detail", visible: false, weight: 40 });
  const cloudSession = useResearchCloudSession();
  const quoteCurrency = financials?.quote?.currency;
  const exchange = ticker?.metadata.exchange ?? "";
  const quotePrice = financials?.quote?.price ?? null;

  const [sortPreference, setSortPreference] = useState<DividendSortPreference>(DEFAULT_SORT_PREFERENCE);
  // Null follows the table's first row, including after a reload.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
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
  useEffect(() => { if (updatedAt !== null) setSelectedKey(null); }, [updatedAt]);

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
  const columns = useMemo(() => buildDividendColumns(rows), [rows]);
  const chartPoints = useMemo(
    () => data?.historyAvailable === false ? [] : buildTrailingCashChartPoints(payments),
    [data?.historyAvailable, payments],
  );
  // A step through the kit, so an annual raise reads as a stair in the legend's units.
  const series = useMemo(() => [staticSeries(
    chartPoints.map((point) => scalarPoint(point.date, point.close)),
    { id: "ttm-dividend", label: "TTM dividend", color: colors.positive, style: "step", calendarSpaced: true },
  )], [chartPoints]);
  const formatCash = useCallback((value: number) => formatDistributionAmount(value, currency), [currency]);
  const formatCashAxis = useMemo(
    () => spanAxisFormatter((value, digits) => formatCurrency(value, currency, Math.max(2, digits))),
    [currency],
  );
  // Payments before the first full trailing year or after today have no point on the line.
  const chartSpan = chartPoints.length >= 2
    ? { first: chartPoints[0]!.date.getTime(), last: chartPoints.at(-1)!.date.getTime() } : null;
  const rowDate = useCallback((row: DividendRow) => {
    const time = Date.parse(`${row.exDate}T00:00:00Z`);
    return chartSpan && time >= chartSpan.first && time <= chartSpan.last ? new Date(time) : null;
  }, [chartSpan?.first, chartSpan?.last]);
  const selectedId = sortedRows.some((row) => row.key === selectedKey) ? selectedKey : sortedRows[0]?.key ?? null;
  const link = useChartTableSelection({
    rows: sortedRows, getId: rowKey, getDate: rowDate, selectedId, onSelect: setSelectedKey, focused,
  });
  // The header row, plus the scrollbar row once the columns overflow the pane.
  const tableChromeRows = chartTableChromeRows(columns, width);
  const fullFigures = metrics ? buildMetricItems(metrics, currency, sortedRows.length > 0, false) : [];
  const keptFigures = chartTableLayout({
    width, height, figures: fullFigures, tableRows: sortedRows.length, tableChromeRows, chart: chartPoints.length >= 2 ? {} : null,
  }).figures;
  // The desktop grid never clips a label; the terminal shortens them rather than clip.
  const figures = metrics && !nativePaneChrome && labelsClip(keptFigures, width)
    ? buildMetricItems(metrics, currency, sortedRows.length > 0, true) : fullFigures;

  const handleHeaderClick = useCallback((columnId: string) => {
    setSortPreference((current) => nextHeaderSort(current, columnId as DividendColumnId, {
      firstDirection: "desc",
      resetTo: DEFAULT_SORT_PREFERENCE,
    }));
  }, []);

  // Only a bare r refreshes; Cmd/Ctrl+Shift+R belongs to the window.
  const handleKeyDown = useCallback((event: DataTableKeyEvent) => (
    handleRefreshKey(event, refresh, { stopPropagation: true })
  ), [refresh]);

  const emptyTitle = !symbol
    ? "No ticker selected."
    : loading
      ? "Loading dividends..."
      : error ?? (data?.historyAvailable ? "No cash distributions reported." : "Dividend history unavailable.");

  if (authWall) return <SignInWall action="view dividend history" needsVerification={cloudSession.needsVerification} />;

  return (
    <DataTableView<DividendRow, DividendColumn>
      focused={focused}
      selection={{ kind: "id", selectedId, getId: rowKey, onChange: (id) => setSelectedKey(id) }}
      onRootKeyDown={handleKeyDown}
      resetScrollKey={symbol}
      rootWidth={width}
      rootHeight={height}
      rootBefore={metrics || chartPoints.length >= 2 ? (
        <ChartTableHeader width={width} height={height} tableRows={sortedRows.length} tableChromeRows={tableChromeRows}
          figures={figures}
          chart={chartPoints.length >= 2 ? {
            series, formatValue: formatCash, formatAxisValue: formatCashAxis, remoteKind: "dividend-ttm-history", ...link,
          } : null} />
      ) : undefined}
      columns={columns}
      items={sortedRows}
      sortColumnId={sortPreference.columnId}
      sortDirection={sortPreference.direction}
      onHeaderClick={handleHeaderClick}
      getItemKey={rowKey}
      renderCell={renderCell}
      selectedTextOverridesCellColor
      emptyStateTitle={emptyTitle}
    />
  );
}
