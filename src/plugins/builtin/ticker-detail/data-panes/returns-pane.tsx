import { useCallback, useEffect, useMemo, useState } from "react";
import { TextAttributes } from "../../../../ui";
import {
  DataTableView,
  QueryBar,
  StatGrid,
  loadingText,
  unavailableText,
  usePaneNoticeFooter,
  usePaneStatusFooter,
  useQueryBarSearch,
  type DataTableCell,
  type DataTableColumn,
  type PaneFooterSegment,
  type PaneHint,
  type StatItem,
} from "../../../../components";
import { usePaneRefreshKey } from "../../../../components/data-table/table-pane";
import { CHART_RESOLUTIONS } from "../../../../time-series/range";
import {
  getChartResolutionLabel,
  isIntradayResolution,
  type ChartResolutionSupport,
  type ManualChartResolution,
} from "../../../../time-series/resolution";
import { historyCoverageNotice } from "../../../../sources/history-coverage";
import { cleanFloat32Price, historyPriceDecimals } from "../../../../cli/history-rows";
import { formatPriceObservation, quoteFormatOptions } from "../../../../market-data/market/format";
import { usePaneTicker } from "../../../../state/app/context";
import type { PaneProps } from "../../../../types/plugin";
import { colors, shownPriceColor } from "../../../../theme/colors";
import { formatPercent } from "../../../../utils/format";
import { publicTickerKey } from "../../../../utils/exchanges";
import { priceHistoryIntegrityNotice } from "../../../../utils/price-history-integrity";
import { compareSortValues, nextHeaderSort, type SortDirection } from "../../../../utils/sort-values";
import { useAssetData, usePluginPaneState } from "../../../runtime";
import { useBoundTicker, useTickerRequest } from "../../shared/ticker-request";
import {
  availableReturnResolutions,
  buildReturnRows,
  closedMarketNote,
  effectiveReturnResolution,
  isTodayReturnRow,
  returnBaseCloseDay,
  returnTimeHeader,
  returnTimeText,
  RETURN_RANGES,
  type ReturnRange,
  type ReturnRow,
  summarizeReturns,
} from "./returns-model";
import { loadReturnSeries, type ReturnSeries } from "./returns-history";
import { formingHistoryBar, formingHistoryBarText, historyBarDate } from "./history-bars";
import { periodBaseText } from "../../../../market-data/market/period-return";
import { DAY_SO_FAR_TEXT } from "../../../../time-series/session-bar";

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

/** A move's tone as it is printed: one that rounds to 0.00% is neutral, never red or green. */
function moveTone(fraction: number): StatItem["tone"] {
  const shown = Number((fraction * 100).toFixed(2));
  return shown > 0 ? "positive" : shown < 0 ? "negative" : "neutral";
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
    return loadReturnSeries(dataProvider, {
      symbol: nextSymbol,
      exchange: nextExchange,
      range,
      resolution,
      support: await supportRequest,
      now: Date.now(),
      forceRefresh,
    });
  }, [dataProvider, range, resolution, supportRequest]);
  const { data, loading, error, reload } = useTickerRequest(loader, symbol, exchange);
  usePaneRefreshKey(reload, { focused: focused && !searchActive });

  const returnRows = useMemo(
    () => data ? buildReturnRows(data.points, data.visibleFrom, data.visibleTo) : [],
    [data],
  );
  const barSize = data?.resolution ?? shownResolution;
  const venue = data?.venue || undefined;
  // The times are dated on the venue's own clock, which the column's header names.
  const timeHeader = returnTimeHeader(barSize, venue);
  const columns = useMemo(() => COLUMNS.map((column) => column.id === "time" ? { ...column, label: timeHeader } : column), [timeHeader]);
  const table = useMemo(() => {
    const searchable = returnRows.length >= SEARCH_MIN_ROWS;
    const needle = searchable ? query.trim().toLowerCase() : "";
    const rows = (needle
      ? returnRows.filter((row) => returnTimeText(row.timestamp, barSize, venue).includes(needle))
      : returnRows.slice()
    ).sort((left, right) => compareSortValues(sortValue(left, sort.columnId), sortValue(right, sort.columnId), sort.direction));
    return { rows, searchable };
  }, [barSize, query, returnRows, sort, venue]);
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
  // A weekly or monthly interval's newest bar is its week or month so far when that has not ended.
  const newestDate = returnRows[0] ? new Date(returnRows[0].timestamp).toISOString().slice(0, 10) : undefined;
  const forming = useMemo(
    () => data ? formingHistoryBar(data.resolution, newestDate, data.venue || undefined, Date.now()) : null,
    [data, newestDate],
  );
  // Today's daily bar is the session still trading, marked as Historical Prices marks it.
  const dayToDate = !!data && isTodayReturnRow(returnRows[0], data.resolution, data.venue || undefined, Date.now());
  const formingKey = forming || dayToDate ? returnRows[0]?.key : undefined;
  // The close every total is measured from: `from Mon 21 Sep close`.
  const baseText = useMemo(() => {
    const day = data && returnRows.length ? returnBaseCloseDay(data.points, data.visibleFrom, data.resolution, data.venue || undefined, Date.now()) : null;
    return day ? periodBaseText(day) : null;
  }, [data, returnRows.length]);
  // A shut market's window ends at its last session, which the footer names.
  const marketInfo = useMemo<PaneFooterSegment[]>(() => [
    ...baseText ? [{ id: "base", parts: [{ text: baseText, tone: "muted" as const }] }] : [],
    ...data?.lastSession
      ? [{ id: "market", parts: [{ text: closedMarketNote(data.lastSession, data.visibleTo), tone: "muted" as const }] }]
      : [],
    ...forming && newestDate ? [{ id: "forming", parts: [{ text: formingHistoryBarText(forming, newestDate), tone: "muted" as const }] }] : [],
    ...dayToDate ? [{ id: "forming", parts: [{ text: DAY_SO_FAR_TEXT, tone: "muted" as const }] }] : [],
  ], [baseText, data, dayToDate, forming, newestDate]);
  usePaneStatusFooter({ registrationId: "returns", loading, error, hints, info: marketInfo });

  const integrityNotice = priceHistoryIntegrityNotice(returnRows.filter((row) => row.inconsistent).length);
  const coverageNotice = data ? historyCoverageNotice(data.coverageStart, data.visibleFrom) : null;
  usePaneNoticeFooter({
    registrationId: "returns:notices",
    notices: [coverageNotice, integrityNotice].filter((notice): notice is string => !!notice),
    focused,
    title: "Price history data",
  });

  // The window's total and its best and worst interval, over every bar it holds, whatever the search narrows the table to.
  const summary = useMemo<StatItem[]>(() => {
    const { total, best, worst } = summarizeReturns(returnRows);
    const moveItem = (id: string, label: string, row: ReturnRow | null): StatItem[] => {
      if (row?.intervalPercent == null) return [];
      const when = historyBarDate(returnTimeText(row.timestamp, barSize, venue), barSize, false);
      return [{
        id,
        label,
        value: formatPercent(row.intervalPercent),
        tone: moveTone(row.intervalPercent),
        detail: when,
        // A narrow pane keeps the day without its year, so the three figures stay on one row.
        ...isIntradayResolution(barSize) ? { detailVariants: [when.slice(5)] } : {},
      }];
    };
    return [
      ...total === null ? [] : [{ id: "total", label: "Total", value: formatPercent(total), tone: moveTone(total) }],
      ...moveItem("best", "Best", best),
      ...moveItem("worst", "Worst", worst),
    ];
  }, [barSize, returnRows, venue]);

  const chooseSort = useCallback((id: string) => {
    setSort((current) => nextHeaderSort(current, id as ReturnColumnId, { firstDirection: "desc" }));
  }, []);

  const renderCell = useCallback((row: ReturnRow, column: ReturnColumn): DataTableCell => {
    switch (column.id) {
      case "time": {
        const shown = returnTimeText(row.timestamp, barSize, venue);
        // A daily or longer bar is a date; a month's reads as the month, and one still running says so.
        return {
          text: isIntradayResolution(barSize) ? shown : historyBarDate(shown, barSize, row.key === formingKey),
          value: new Date(row.timestamp).toISOString(),
          color: colors.textDim,
        };
      }
      case "price":
        return { text: formatMaybePrice(row.price, priceDecimals, column.width), value: exportPrice(row.price, priceDecimals), color: colors.textBright, attributes: TextAttributes.BOLD };
      case "intervalChange":
        return { text: formatMaybePrice(row.intervalChange, priceDecimals, column.width), value: exportPrice(row.intervalChange, priceDecimals), color: shownPriceColor(row.intervalChange ?? 0, priceDecimals) };
      case "intervalPercent":
        return { text: formatMaybePercent(row.intervalPercent), value: row.intervalPercent === null ? null : row.intervalPercent * 100, color: shownPriceColor((row.intervalPercent ?? 0) * 100, 2) };
      case "cumulativeChange":
        return { text: formatMaybePrice(row.cumulativeChange, priceDecimals, column.width), value: exportPrice(row.cumulativeChange, priceDecimals), color: shownPriceColor(row.cumulativeChange ?? 0, priceDecimals) };
      case "cumulativePercent":
        return { text: formatMaybePercent(row.cumulativePercent), value: row.cumulativePercent === null ? null : row.cumulativePercent * 100, color: shownPriceColor((row.cumulativePercent ?? 0) * 100, 2) };
    }
  }, [barSize, formingKey, priceDecimals, venue]);

  return (
    <DataTableView<ReturnRow, ReturnColumn>
      focused={focused && !searchActive}
      selection={{ kind: "none" }}
      rootWidth={width}
      rootHeight={height}
      columns={columns}
      items={table.rows}
      sortColumnId={sort.columnId}
      sortDirection={sort.direction}
      onHeaderClick={chooseSort}
      getItemKey={(row) => row.key}
      renderCell={renderCell}
      selectedTextOverridesCellColor
      rootBefore={(
        <>
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
          <StatGrid items={summary} width={width} />
        </>
      )}
      getExportMetadata={() => [
        ["Ticker", symbol ? publicTickerKey(symbol, exchange) : ""],
        ["Range", data?.range ?? range],
        ["Interval", getChartResolutionLabel(data?.resolution ?? shownResolution)],
        ...(forming && newestDate ? [["Partial bar", `${newestDate}, ${formingHistoryBarText(forming, newestDate)}`]] : []),
        ...(dayToDate && newestDate ? [["Partial bar", `${newestDate}, ${DAY_SO_FAR_TEXT}`]] : []),
        ...(baseText ? [["Base", baseText]] : []),
        ["Window", data ? `after ${new Date(data.visibleFrom).toISOString()} through ${new Date(data.visibleTo).toISOString()}` : ""],
        ...(data?.lastSession ? [["Market", closedMarketNote(data.lastSession, data.visibleTo)]] : []),
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
