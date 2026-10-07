import { useCallback, useEffect, useMemo, useState } from "react";
import { TextAttributes } from "../../../../ui";
import {
  DataTableView,
  QueryBar,
  loadingText,
  unavailableText,
  usePaneNoticeFooter,
  usePaneStatusFooter,
  useQueryBarSearch,
  type DataTableCell,
  type DataTableColumn,
  type PaneHint,
} from "../../../../components";
import { usePaneRefreshKey } from "../../../../components/data-table/table-pane";
import { CHART_RESOLUTIONS } from "../../../../time-series/range";
import {
  getChartResolutionLabel,
  type ChartResolutionSupport,
  type ManualChartResolution,
} from "../../../../time-series/resolution";
import { fetchHistoryResult, InvalidHistoryResultError } from "../../../../sources/history-result";
import { historyCoverageNotice } from "../../../../sources/history-coverage";
import { historyRetentionNotice, isHistoryRetentionError } from "../../../../sources/history-retention";
import { cleanFloat32Price, historyPriceDecimals } from "../../../../cli/history-rows";
import { formatPriceObservation, quoteFormatOptions } from "../../../../market-data/market/format";
import { usePaneTicker } from "../../../../state/app/context";
import type { PaneProps } from "../../../../types/plugin";
import type { PricePoint } from "../../../../types/financials";
import { colors, priceColor } from "../../../../theme/colors";
import { formatPercent } from "../../../../utils/format";
import { publicTickerKey } from "../../../../utils/exchanges";
import { priceHistoryIntegrityNotice } from "../../../../utils/price-history-integrity";
import { compareSortValues, nextHeaderSort, type SortDirection } from "../../../../utils/sort-values";
import { useAssetData, usePluginPaneState } from "../../../runtime";
import { useBoundTicker, useTickerRequest } from "../../shared/ticker-request";
import {
  availableReturnResolutions,
  buildReturnRows,
  effectiveReturnResolution,
  endsAtLatestBar,
  latestBarTime,
  RETURN_RANGES,
  returnLookbackMs,
  returnSupportRange,
  returnVisibleFrom,
  type ReturnRange,
  type ReturnRow,
} from "./returns-model";

type ReturnColumnId = "time" | "price" | "intervalChange" | "intervalPercent" | "cumulativeChange" | "cumulativePercent";
type ReturnColumn = DataTableColumn & { id: ReturnColumnId };

const INTERVAL_OPTIONS = CHART_RESOLUTIONS.filter((value): value is ManualChartResolution => value !== "auto");
const SEARCH_MIN_ROWS = 8;
const NO_SUPPORT: readonly ChartResolutionSupport[] = [];

const COLUMNS: ReturnColumn[] = [
  { id: "time", label: "TIME", width: 16, align: "left" },
  { id: "price", label: "PRICE", width: 10, align: "right", flexGrow: 1 },
  { id: "intervalChange", label: "INT $", width: 10, align: "right", flexGrow: 1 },
  { id: "intervalPercent", label: "INT %", width: 9, align: "right", flexGrow: 1 },
  { id: "cumulativeChange", label: "TOTAL $", width: 10, align: "right", flexGrow: 1 },
  { id: "cumulativePercent", label: "TOTAL %", width: 9, align: "right", flexGrow: 1 },
];

interface ReturnSeries {
  points: PricePoint[];
  visibleFrom: number;
  visibleTo: number;
  coverageStart?: string;
  range: ReturnRange;
  resolution: ManualChartResolution;
}

function formatDateTime(date: Date): string {
  const iso = date.toISOString();
  const hasTime = date.getUTCHours() !== 0 || date.getUTCMinutes() !== 0 || date.getUTCSeconds() !== 0;
  return hasTime ? iso.slice(0, 16).replace("T", " ") : iso.slice(0, 10);
}

/** Every price and dollar change at one decimal count, so the columns line up. */
function returnPriceDecimals(rows: readonly ReturnRow[], assetCategory?: string): number {
  return historyPriceDecimals(rows.flatMap((row) => row.price === null ? [] : [{
    date: "",
    open: null,
    high: null,
    low: null,
    close: cleanFloat32Price(row.price),
    volume: null,
  }]), assetCategory);
}

function formatMaybePrice(value: number | null, decimals: number, width: number): string {
  if (value === null || !Number.isFinite(value)) return "-";
  return formatPriceObservation(Number(value.toFixed(Math.min(20, decimals))), { minimumFractionDigits: decimals, maxWidth: width });
}

function exportPrice(value: number | null, decimals: number): number | null {
  return value === null || !Number.isFinite(value) ? null : Number(value.toFixed(Math.min(20, decimals)));
}

function formatMaybePercent(value: number | null): string {
  return value === null ? "-" : formatPercent(value);
}

function sortValue(row: ReturnRow, id: ReturnColumnId): number | null {
  switch (id) {
    case "time":
      return row.timestamp;
    case "price":
      return row.price;
    case "intervalChange":
      return row.intervalChange;
    case "intervalPercent":
      return row.intervalPercent;
    case "cumulativeChange":
      return row.cumulativeChange;
    case "cumulativePercent":
      return row.cumulativePercent;
  }
}

function historyErrorMessage(error: unknown, resolution: ManualChartResolution): Error {
  const label = getChartResolutionLabel(resolution);
  if (isHistoryRetentionError(error)) return new Error(historyRetentionNotice(error.retention, label, null));
  // The source answered at another cadence than asked: those bars are not this interval's returns.
  if (error instanceof InvalidHistoryResultError) return new Error(`${label} bars are unavailable for this ticker`);
  return error instanceof Error ? error : new Error(String(error));
}

export function ReturnsPane({ focused, width, height }: PaneProps) {
  const dataProvider = useAssetData();
  const { symbol, exchange, ticker } = useBoundTicker();
  const [range, setRange] = usePluginPaneState<ReturnRange>("range", "5D");
  const [resolution, setResolution] = usePluginPaneState<ManualChartResolution>("interval", "1h");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ columnId: ReturnColumnId; direction: SortDirection }>({ columnId: "time", direction: "desc" });
  const { active: searchActive, focus: focusSearch, blur: blurSearch, searchProps } = useQueryBarSearch();

  // What the source serves, and how far back each interval reaches. The loader
  // waits for it, so a range the chosen interval cannot cover is never requested.
  const supportRequest = useMemo(() => Promise.resolve(
    symbol && dataProvider?.getChartResolutionSupport
      ? dataProvider.getChartResolutionSupport(symbol, exchange)
      : NO_SUPPORT,
  ).catch(() => NO_SUPPORT), [dataProvider, exchange, symbol]);
  const [support, setSupport] = useState<readonly ChartResolutionSupport[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSupport(null);
    void supportRequest.then((value) => { if (!cancelled) setSupport(value); });
    return () => { cancelled = true; };
  }, [supportRequest]);
  const availableResolutions = useMemo(
    () => new Set(availableReturnResolutions(range, support ?? NO_SUPPORT)),
    [range, support],
  );
  // The chosen interval stays saved; a range it cannot cover shows the nearest
  // coarser one until the range allows it again.
  const shownResolution = support ? effectiveReturnResolution(range, resolution, support) : resolution;

  const loader = useCallback(async (nextSymbol: string, nextExchange: string, forceRefresh: boolean): Promise<ReturnSeries> => {
    if (!dataProvider) throw new Error("Market data unavailable");
    const sourceSupport = await supportRequest;
    const interval = effectiveReturnResolution(range, resolution, sourceSupport);
    const now = Date.now();
    const visibleFrom = returnVisibleFrom(range, interval, now);
    const start = new Date(visibleFrom - returnLookbackMs(range, interval, sourceSupport));
    const end = new Date(now);
    const context = forceRefresh ? { cacheMode: "refresh" as const } : undefined;
    let result;
    try {
      // Exact bounds first, then the interval's range history, as charts do
      // when a source keeps no bars for the exact window.
      result = await fetchHistoryResult(dataProvider, nextSymbol, nextExchange, { kind: "detail", start, end, interval }, context);
      if (!result?.points.length) {
        result = await fetchHistoryResult(dataProvider, nextSymbol, nextExchange, { kind: "resolution", range: returnSupportRange(range), resolution: interval }, context) ?? result;
      }
    } catch (error) {
      throw historyErrorMessage(error, interval);
    }
    if (!result) throw new Error("Price history unavailable");
    const latest = latestBarTime(result.points);
    return {
      points: result.points,
      // A closed market leaves a short window ending now without bars, so it
      // ends at the latest bar instead.
      visibleFrom: endsAtLatestBar(range) && latest !== null ? returnVisibleFrom(range, interval, latest) : visibleFrom,
      visibleTo: now,
      ...(result.coverageStart ? { coverageStart: result.coverageStart } : {}),
      range,
      resolution: interval,
    };
  }, [dataProvider, range, resolution, supportRequest]);
  const { data, loading, error, reload } = useTickerRequest(loader, symbol, exchange);
  usePaneRefreshKey(reload, { focused: focused && !searchActive });

  const returnRows = useMemo(
    () => data ? buildReturnRows(data.points, data.visibleFrom, data.visibleTo) : [],
    [data],
  );
  const table = useMemo(() => {
    const searchable = returnRows.length >= SEARCH_MIN_ROWS;
    const needle = searchable ? query.trim().toLowerCase() : "";
    const rows = (needle
      ? returnRows.filter((row) => formatDateTime(new Date(row.timestamp)).toLowerCase().includes(needle))
      : returnRows.slice()
    ).sort((left, right) => compareSortValues(sortValue(left, sort.columnId), sortValue(right, sort.columnId), sort.direction));
    return { rows, searchable };
  }, [query, returnRows, sort]);
  // The quote knows the instrument type even when the saved ticker does not,
  // so prices take the same decimals as Historical Prices.
  const { financials } = usePaneTicker();
  const assetCategory = quoteFormatOptions(
    financials?.quote,
    ticker?.metadata.assetCategory,
    financials?.quoteMetadata?.instrumentType,
  ).assetCategory;
  const priceDecimals = useMemo(() => returnPriceDecimals(returnRows, assetCategory), [assetCategory, returnRows]);

  useEffect(() => {
    if (table.searchable) return;
    if (query) setQuery("");
    if (searchActive) blurSearch();
  }, [blurSearch, query, searchActive, table.searchable]);

  const hints = useMemo<PaneHint[]>(() => (
    table.searchable ? [{ id: "search", key: "/", label: "search", onPress: focusSearch }] : []
  ), [focusSearch, table.searchable]);
  usePaneStatusFooter({ registrationId: "returns", loading, error, hints });

  const integrityNotice = priceHistoryIntegrityNotice(returnRows.filter((row) => row.inconsistent).length);
  const coverageNotice = data ? historyCoverageNotice(data.coverageStart, data.visibleFrom) : null;
  usePaneNoticeFooter({
    registrationId: "returns:notices",
    notices: [coverageNotice, integrityNotice].filter((notice): notice is string => !!notice),
    focused,
    title: "Price history data",
  });

  const chooseSort = useCallback((id: string) => {
    setSort((current) => nextHeaderSort(current, id as ReturnColumnId, { firstDirection: "desc" }));
  }, []);

  const renderCell = useCallback((row: ReturnRow, column: ReturnColumn): DataTableCell => {
    switch (column.id) {
      case "time":
        return { text: formatDateTime(new Date(row.timestamp)), value: new Date(row.timestamp).toISOString(), color: colors.textDim };
      case "price":
        return { text: formatMaybePrice(row.price, priceDecimals, column.width), value: exportPrice(row.price, priceDecimals), color: colors.textBright, attributes: TextAttributes.BOLD };
      case "intervalChange":
        return { text: formatMaybePrice(row.intervalChange, priceDecimals, column.width), value: exportPrice(row.intervalChange, priceDecimals), color: priceColor(row.intervalChange ?? 0) };
      case "intervalPercent":
        return { text: formatMaybePercent(row.intervalPercent), value: row.intervalPercent === null ? null : row.intervalPercent * 100, color: priceColor(row.intervalPercent ?? 0) };
      case "cumulativeChange":
        return { text: formatMaybePrice(row.cumulativeChange, priceDecimals, column.width), value: exportPrice(row.cumulativeChange, priceDecimals), color: priceColor(row.cumulativeChange ?? 0) };
      case "cumulativePercent":
        return { text: formatMaybePercent(row.cumulativePercent), value: row.cumulativePercent === null ? null : row.cumulativePercent * 100, color: priceColor(row.cumulativePercent ?? 0) };
    }
  }, [priceDecimals]);

  return (
    <DataTableView<ReturnRow, ReturnColumn>
      focused={focused && !searchActive}
      selection={{ kind: "none" }}
      rootWidth={width}
      rootHeight={height}
      columns={COLUMNS}
      items={table.rows}
      sortColumnId={sort.columnId}
      sortDirection={sort.direction}
      onHeaderClick={chooseSort}
      getItemKey={(row) => row.key}
      renderCell={renderCell}
      selectedTextOverridesCellColor
      rootBefore={(
        <QueryBar
          width={width}
          search={table.searchable ? {
            value: query,
            onChange: setQuery,
            placeholder: "date or time",
            focused,
            ...searchProps,
          } : undefined}
          filters={[{
            id: "range",
            label: "Range",
            value: range,
            options: RETURN_RANGES.map((value) => ({ value, label: value })),
            onChange: setRange,
          }, {
            id: "interval",
            label: "Interval",
            value: shownResolution,
            options: INTERVAL_OPTIONS.map((value) => ({
              value,
              label: getChartResolutionLabel(value),
              disabled: support !== null && !availableResolutions.has(value),
            })),
            onChange: setResolution,
          }]}
        />
      )}
      getExportMetadata={() => [
        ["Ticker", symbol ? publicTickerKey(symbol, exchange) : ""],
        ["Range", data?.range ?? range],
        ["Interval", getChartResolutionLabel(data?.resolution ?? shownResolution)],
        ["Window", data ? `after ${new Date(data.visibleFrom).toISOString()} through ${new Date(data.visibleTo).toISOString()}` : ""],
        ["Time zone", "UTC, bar open"],
        ["Basis", "Price returns of bar closes; dividends are not included"],
        ...(coverageNotice ? [["Coverage", coverageNotice]] : []),
        ...(integrityNotice ? [["Warning", integrityNotice]] : []),
        ...(error ? [["Error", error]] : []),
      ]}
      emptyStateTitle={error
        ? unavailableText("Returns")
        : loading
          ? loadingText("returns")
          : query.trim()
            ? "No matching times"
            : "No bars in this window"}
      emptyStateHint={error ?? undefined}
    />
  );
}
