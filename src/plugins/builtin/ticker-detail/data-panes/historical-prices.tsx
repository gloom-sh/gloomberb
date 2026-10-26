import { useCallback, useMemo } from "react";
import { TextAttributes } from "../../../../ui";
import {
  DataTableView,
  QueryBar,
  usePaneNoticeFooter,
  loadingText,
  unavailableText,
  usePaneStatusFooter,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
  type PaneFooterSegment,
} from "../../../../components";
import { TIME_RANGES, type TimeRange } from "../../../../time-series/range";
import type { PaneProps } from "../../../../types/plugin";
import type { PricePoint } from "../../../../types/financials";
import { colors, priceColor } from "../../../../theme/colors";
import { formatCompact, formatPercent } from "../../../../utils/format";
import { isPlainKeyboardEvent } from "../../../../utils/keyboard";
import { publicTickerKey } from "../../../../utils/exchanges";
import { quoteFormatOptions } from "../../../../market-data/market/format";
import {
  barPriceDecimals, formatBarPrice, historyAllStart, historyBarsAfterHole, historyChangeBaseNote, historyMissingPeriodsNote,
} from "../../../../cli/history-rows";
import {
  MISSING_VOLUME_TEXT, missingVolumeCount, missingVolumeNotice, pricePointValues, priceHistoryIntegrityNotice,
} from "../../../../utils/price-history-integrity";
import {
  useAssetData,
  useDebouncedPluginPaneState,
  usePluginPaneState,
} from "../../../runtime";
import { usePaneTicker } from "../../../../state/app/context";
import { handleRefreshKey, useClampSelectedIndex } from "../../../../components/data-table/table-pane";
import { useBoundTicker, useTickerRequest } from "../../shared/ticker-request";
import { DAY_SO_FAR_TEXT, withSessionBar } from "../../../../time-series/session-bar";
import {
  formingHistoryBar,
  formingHistoryBarText,
  HISTORY_DEFAULT_RANGE,
  historyBarDate,
  historyBarSize,
  historyBarSizeText,
  historyBarSizeWord,
  historyDateHeader,
  type HistoryBarSize,
} from "./history-bars";

type HistoryColumnId = "date" | "open" | "high" | "low" | "close" | "change" | "changePercent" | "volume";
type HistoryColumn = DataTableColumn & { id: HistoryColumnId };

export type HistoricalPriceRow = {
  key: string;
  point: ReturnType<typeof pricePointValues>;
  /** The bar's date as the table reads it: `2026-10 MTD` for a month still running, `2026-10-16 DTD` for today's session. */
  date: string;
  /** What a CSV export writes for the date: the bar's own date, whatever the table says of its period. */
  exportDate: string;
  /** The bar carries a time of day, so the table dates it with one. */
  timed: boolean;
  /** When the bar opens, or the time of the latest trade an intraday history can end with (latestTradeIndex). */
  time: number;
  /** The bar's period had not ended: a week or month still running, or the day's session still trading. */
  partial: boolean;
  /** A coin's day Gloom Cloud rebuilt from hourly bars, which has no volume of its own. */
  filled: boolean;
  change: number | null;
  changePercent: number | null;
  /** Periods without a bar lie between this bar and the one before, so its change spans them (marked `*`). */
  changeSpansGap: boolean;
};

function pricePointDate(point: PricePoint): Date | null {
  const value = point.date as Date | string | number;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatDateTime(date: Date): string {
  const iso = date.toISOString();
  const hasTime = date.getUTCHours() !== 0 || date.getUTCMinutes() !== 0 || date.getUTCSeconds() !== 0;
  return hasTime ? iso.slice(0, 16).replace("T", " ") : iso.slice(0, 10);
}

/** Every price in the table at one decimal count, so the columns line up. */
function formatMaybePrice(value: number | null | undefined, decimals: number, width: number): string {
  return value == null || !Number.isFinite(value) ? "-" : formatBarPrice(value, decimals, width);
}

/** The decimals the table's prices need: the one rule `history` and `fn HP` print by (barPriceDecimals). */
function historicalPriceDecimals(rows: readonly HistoricalPriceRow[], assetCategory?: string): number {
  return barPriceDecimals(rows.map(({ point }) => point), assetCategory);
}

/** The exported price: the digits the table shows, without the width limit. */
function exportPrice(value: number | null | undefined, decimals: number): number | null {
  return value == null || !Number.isFinite(value) ? null : Number(value.toFixed(Math.min(20, decimals)));
}

function formatMaybePercent(value: number | null): string {
  return value == null ? "-" : formatPercent(value);
}

/** A change across periods without a bar, marked `*`: its base is the bar before them, which the gap notice names. */
function spanMark(text: string, row: Pick<HistoricalPriceRow, "changeSpansGap">, value: number | null): string {
  return row.changeSpansGap && value != null ? `${text}*` : text;
}

/** Volume as the table shows it; missing reads as missing (`volumeMissing`) in a history that reports volume, never 0. */
function formatVolume(value: number | null | undefined, volumeMissing: boolean): string {
  return value == null ? volumeMissing ? MISSING_VOLUME_TEXT : "-" : formatCompact(value);
}

interface HistoricalPriceTable {
  /** Newest first. */
  rows: HistoricalPriceRow[];
  size: HistoryBarSize;
  /** The newest bar's week or month had not ended, and how far into it the bar runs. */
  forming: ReturnType<typeof formingHistoryBar>;
  /** The newest bar is a day whose session is still trading. */
  dayToDate: boolean;
  /** The newest bar's day, `YYYY-MM-DD`. */
  newestDate: string | undefined;
  /** The months or weeks without a bar, named (historyMissingPeriodsNote), and what each change after them is from. */
  gapNotices: string[];
}

function buildHistoricalPriceRows(points: PricePoint[], venue: string | undefined, now: number): HistoricalPriceTable {
  const sorted = points
    .flatMap((point, sourceIndex) => {
      const date = pricePointDate(point);
      return date ? [{ point: pricePointValues(point), date, sourceIndex, partial: point.partial === true, filled: point.filled === true }] : [];
    })
    .sort((left, right) => left.date.getTime() - right.date.getTime());
  const size = historyBarSize(sorted.map((entry) => entry.date.getTime()));
  const newestDate = sorted.at(-1)?.date.toISOString().slice(0, 10);
  const forming = formingHistoryBar(size, newestDate, venue, now);
  const dayToDate = size === "1d" && sorted.at(-1)?.partial === true;
  // A month or week without a bar, or a break in daily bars, is named; the change after it is from the bar before it.
  const times = sorted.map((entry) => entry.date.getTime());
  const interval = size === "intraday" ? null : size;
  const afterGap = historyBarsAfterHole(times, interval);
  const gapNotices = [historyMissingPeriodsNote(times, interval), historyChangeBaseNote(times, interval)]
    .filter((notice): notice is string => notice != null);
  const rows = sorted.map((entry, index) => {
    const previous = sorted[index - 1]?.point;
    const { point, date, sourceIndex, filled } = entry;
    const newest = index === sorted.length - 1;
    const partial = newest && (!!forming || dayToDate);
    const change = previous?.close != null && point.close != null ? point.close - previous.close : null;
    const shown = formatDateTime(date);
    const timed = shown.length > 10;
    return {
      key: `${date.toISOString()}:${sourceIndex}`,
      point,
      date: timed ? shown : historyBarDate(shown, size, partial),
      exportDate: shown,
      timed,
      time: date.getTime(),
      partial,
      filled,
      change,
      changePercent: previous?.close && change !== null ? change / previous.close : null,
      changeSpansGap: afterGap[index] === true,
    };
  }).reverse();
  return { rows, size, forming, dayToDate, newestDate, gapNotices };
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
function buildHistoryColumns(width: number, intraday: boolean, size: HistoryBarSize, newestDate: string): HistoryColumn[] {
  // A month reads as `2026-10`; the newest bar, when its week or month runs on, adds `MTD` or `WTD`.
  const dateWidth = Math.max(intraday ? 16 : size === "1mo" ? 7 : 10, newestDate.length);
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
    { id: "date", label: intraday ? "DATE/TIME" : historyDateHeader(size)?.toUpperCase() ?? "DATE", width: dateWidth, align: "left" },
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
  const [range, setRange] = usePluginPaneState<TimeRange>("range", HISTORY_DEFAULT_RANGE);
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
  // The quote knows the instrument type even when the saved ticker does not;
  // resolve it the way every quote display does. It also names the venue
  // whose sessions say whether a week or month is still running.
  const { financials } = usePaneTicker();
  const venue = exchange || financials?.quote?.listingExchangeName || financials?.quote?.exchangeName || undefined;
  // While the session trades the day's bar is the quote's: the history keeps a
  // snapshot of it from whenever it was last fetched (withSessionBar).
  const quote = financials?.quote;
  const points = useMemo(
    () => withSessionBar(data ?? [], quote, { now: Date.now(), venue }),
    [data, quote, venue],
  );
  const { rows, size, forming, dayToDate, newestDate, gapNotices } = useMemo(
    () => buildHistoricalPriceRows(points, venue, Date.now()),
    [points, venue],
  );
  const integrityNotice = priceHistoryIntegrityNotice(rows.filter((row) => row.point.integrity).length);
  const volumeMissing = useMemo(() => missingVolumeCount(rows.map((row) => ({
    ...row.point, date: row.time, partial: row.partial, filled: row.filled,
  }))), [rows]);
  const volumeNotice = missingVolumeNotice(volumeMissing, rows.length);
  // Daily and longer bars are dates; only intraday bars carry a time.
  const intraday = rows.length > 0 ? rows.some((row) => row.timed) : range === "1D" || range === "1W";
  const newestRowDate = rows[0]?.date ?? "";
  const columns = useMemo(() => buildHistoryColumns(width, intraday, size, newestRowDate), [intraday, newestRowDate, size, width]);
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
    // A modified key is an app chord (Cmd/Ctrl+Shift+R resizes the pane).
    if (!isPlainKeyboardEvent(event)) return false;
    if (handleRefreshKey(event, reload)) return true;
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
  ): DataTableCell => {
    switch (column.id) {
      case "date":
        return { text: row.date, value: row.exportDate, color: colors.textDim };
      case "open":
      case "high":
      case "low":
      case "close":
        return {
          text: formatMaybePrice(row.point[column.id], priceDecimals, column.width),
          value: exportPrice(row.point[column.id], priceDecimals),
          ...(column.id === "close" ? { color: colors.textBright, attributes: TextAttributes.BOLD } : { color: colors.text }),
        };
      case "change":
        return { text: spanMark(formatMaybePrice(row.change, priceDecimals, column.width - (row.changeSpansGap ? 1 : 0)), row, row.change),
          value: exportPrice(row.change, priceDecimals), color: priceColor(row.change ?? 0) };
      case "changePercent":
        return { text: spanMark(formatMaybePercent(row.changePercent), row, row.changePercent),
          value: row.changePercent == null ? null : row.changePercent * 100, color: priceColor(row.changePercent ?? 0) };
      case "volume":
        return { text: formatVolume(row.point.volume, volumeMissing > 0), value: row.point.volume ?? null, color: colors.textDim };
    }
  }, [priceDecimals, volumeMissing]);

  // ALL starts where the source's bars do, when that is well inside the window (BTC-USD's in 2014-09).
  const oldestDate = rows.at(-1)?.exportDate;
  const allStart = historyAllStart(range, size === "intraday" ? null : size, oldestDate);

  // The range is picked in the query bar; t still steps through it. The range
  // sets the bar size, which the footer says, and a week or month still
  // running says how far the newest bar goes.
  const barInfo = useMemo<PaneFooterSegment[]>(() => [
    ...rows.length > 0 ? [{ id: "bars", parts: [{
      text: allStart ? `${historyBarSizeText(size)} from ${allStart}` : historyBarSizeText(size), tone: "muted" as const,
    }] }] : [],
    ...forming && newestDate ? [{ id: "forming", parts: [{ text: formingHistoryBarText(forming, newestDate), tone: "muted" as const }] }] : [],
    ...dayToDate ? [{ id: "forming", parts: [{ text: DAY_SO_FAR_TEXT, tone: "muted" as const }] }] : [],
  ], [allStart, dayToDate, forming, newestDate, rows.length, size]);
  usePaneStatusFooter({ registrationId: "historical-prices", loading, error, info: barInfo });

  usePaneNoticeFooter({
    registrationId: "historical-prices:integrity",
    notices: [integrityNotice, volumeNotice, ...gapNotices].filter((notice): notice is string => !!notice),
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
      selectedTextOverridesCellColor
      getExportMetadata={() => [
        ["Ticker", symbol ? publicTickerKey(symbol, exchange) : ""],
        ["Requested range", range],
        ...(rows.length > 0 ? [["Bar size", historyBarSizeWord(size)]] : []),
        ["Time zone", "UTC"],
        ...(forming && newestDate ? [["Partial bar", `${newestDate}, ${formingHistoryBarText(forming, newestDate)}`]] : []),
        ...(dayToDate && newestDate ? [["Partial bar", `${newestDate}, ${DAY_SO_FAR_TEXT}`]] : []),
        ["Price units", "As served in the history; currency and price-basis metadata are unavailable"],
        ["Status", error ? (rows.length ? "Retained after refresh failure" : "Unavailable")
          : loading ? (rows.length ? "Refreshing" : "Loading") : rows.length ? "Available" : "Empty"],
        ...(allStart ? [["Source starts", allStart]] : []),
        ...(integrityNotice ? [["Warning", integrityNotice]] : []),
        ...gapNotices.map((notice) => ["Gap note", notice]),
        ...(volumeNotice ? [["Volume note", volumeNotice]] : []),
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
