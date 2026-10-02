import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  chartTableChromeRows,
  ChartTableHeader,
  CompositeChart,
  DataTableView,
  EmptyState,
  PaneStatusBody,
  QueryBar,
  scalarPoint,
  staticSeries,
  useChartTableSelection,
  usePaneMenuItems,
  usePaneNoticeFooter,
  usePaneTabs,
  type ChartStripSpec,
  type ChartTableSelection,
  type CompositeAxisDomain,
  type DataTableCell,
  type DataTableColumn,
  type PaneFooterSegment,
  type QueryBarFilter,
  type StatItem,
} from "../../../components";
import { formatCompactAxis } from "../../../components/chart-table";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { usePaneStatusFooter } from "../../../components/layout/pane/status-footer";
import { useAsyncResource, usePaneSettingValue, usePluginPaneState, usePrunePluginPaneState } from "../../../public/react";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { useShortcut } from "../../../react/input";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";
import { useThemeColors } from "../../../theme/theme-context";
import type { ResolvedSeries } from "../../../time-series/types";
import type { PaneProps } from "../../../types/plugin";
import { Box, Text } from "../../../ui";
import { formatCompact } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
import { nextHeaderSort, type SortDirection } from "../../../utils/sort-values";
import { useCloudAccessFooter } from "../shared/cloud-upgrade";
import {
  loadGamma,
  loadOpenInterest,
  positioningSymbol,
  type ExpiryOpenInterest,
  type GammaPayload,
  type GammaStrike,
  type OpenInterestPayload,
  type StrikeOpenInterest,
} from "./client";
import {
  ALL_EXPIRIES,
  chartWindow,
  expiryAxis,
  expiryLabel,
  formatCount,
  formatCountChange,
  formatDistance,
  formatGamma,
  formatLevel,
  formatPayout,
  formatRatio,
  formatStrike,
  isPositioningTab,
  POSITIONING_TABS,
  strikeAxis,
  type PositioningTab,
} from "./model";

const PANELS = [{ id: "main" }];
const EXPIRY_PREVIOUS_KEY = "[";
const EXPIRY_NEXT_KEY = "]";
/** Legend, four plot rows, the strike axis and the row naming spot and the other levels. */
const CHART_MIN_ROWS = 7;
/** Cells the value axis takes off the band, for spacing strike labels. */
const VALUE_GUTTER = 8;
/** OI moves once a session, spot all day; gamma follows the quotes. */
const OPEN_INTEREST_REFRESH_MS = 5 * 60_000;
const GAMMA_REFRESH_MS = 60_000;

type Sort = { columnId: string; direction: SortDirection };

const strikeKey = (row: { strike: number }) => String(row.strike);
const expiryKey = (row: ExpiryOpenInterest) => row.date;
/** Sep 29: the OI session is days old, so the footer leaves out its year. */
const shortDate = (date: string) => expiryLabel(date).replace(/ '\d\d$/, "");
const total = (row: { callOI: number | null; putOI: number | null }) => (row.callOI ?? 0) + (row.putOI ?? 0);

function strikeColumns(changes: boolean): DataTableColumn[] {
  return [
    { id: "strike", label: "Strike", width: 9, align: "left" },
    { id: "callOI", label: "Call OI", width: 10, align: "right" },
    ...(changes ? [{ id: "callChange", label: "Call chg", width: 9, align: "right" as const }] : []),
    { id: "putOI", label: "Put OI", width: 10, align: "right" },
    ...(changes ? [{ id: "putChange", label: "Put chg", width: 9, align: "right" as const }] : []),
    { id: "payout", label: "Payout $", width: 10, align: "right" },
  ];
}
function expiryColumns(changes: boolean): DataTableColumn[] {
  return [
    { id: "date", label: "Expiry", width: 11, align: "left" },
    { id: "days", label: "Days", width: 5, align: "right" },
    { id: "callOI", label: "Call OI", width: 11, align: "right" },
    { id: "putOI", label: "Put OI", width: 11, align: "right" },
    { id: "putCallRatio", label: "P/C", width: 6, align: "right" },
    ...(changes ? [{ id: "change", label: "OI chg", width: 10, align: "right" as const }] : []),
    { id: "maxPain", label: "Max pain", width: 9, align: "right" },
    { id: "distance", label: "Vs spot", width: 8, align: "right" },
  ];
}
const GAMMA_COLUMNS: DataTableColumn[] = [
  { id: "strike", label: "Strike", width: 9, align: "left" },
  { id: "calls", label: "Call GEX $", width: 11, align: "right" },
  { id: "puts", label: "Put GEX $", width: 11, align: "right" },
  { id: "net", label: "Net GEX $", width: 11, align: "right" },
  { id: "distance", label: "Vs spot", width: 8, align: "right" },
];

function sortRows<T>(rows: readonly T[], sort: Sort, value: (row: T, columnId: string) => number | string | null): T[] {
  const direction = sort.direction === "asc" ? 1 : -1;
  return rows.toSorted((left, right) => {
    const a = value(left, sort.columnId);
    const b = value(right, sort.columnId);
    // Missing values sink, whichever way the column sorts.
    if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;
    return (a < b ? -1 : a > b ? 1 : 0) * direction;
  });
}

interface PositioningChartProps {
  width: number;
  height: number;
  series: ResolvedSeries[];
  ticks: (plotWidth: number) => Array<{ label: string; ratio: number }>;
  markers: Array<{ id: string; ratio: number | null; label: string; color: string }>;
  formatCursor: (ratio: number) => string;
  formatValue: (value: number) => string;
  formatAxisValue: (value: number, domain: CompositeAxisDomain) => string;
  selection: ChartTableSelection;
  legendAccessory?: ReactNode;
  legendAccessoryWidth?: number;
  remoteKind: string;
}

/** Columns across a numeric axis (strikes, or expiries one slot apart), with spot and the other levels as guide lines. */
function PositioningChart(props: PositioningChartProps) {
  const xAxis = useMemo(() => ({
    ticks: props.ticks(Math.max(1, props.width - VALUE_GUTTER)),
    markers: props.markers.flatMap((marker) => marker.ratio != null && marker.ratio >= 0 && marker.ratio <= 1
      ? [{ id: marker.id, xRatio: marker.ratio, label: marker.label, color: marker.color }] : []),
    formatCursor: props.formatCursor,
  }), [props.formatCursor, props.markers, props.ticks, props.width]);
  return <CompositeChart series={props.series} panels={PANELS} width={props.width} height={props.height}
    focused={false} navigable={false} showLegend showTimeAxis xAxis={xAxis}
    formatValue={(value) => props.formatValue(value)} formatAxisValue={props.formatAxisValue}
    cursorDate={props.selection.cursorDate} onCursorDateChange={props.selection.onCursorDateChange}
    onActivate={props.selection.onActivate} legendAccessory={props.legendAccessory}
    legendAccessoryWidth={props.legendAccessoryWidth} remoteKind={props.remoteKind} />;
}

/** Saved choices that belong to one underlying, stored as `opx:expiry:<symbol>`. */
const UNDERLYING_STATE_KEY = /^opx:(expiry|gammaExpiry|strike|expiryRow|gammaStrike)(:|$)/;

export function OptionsPositioningPane(props: PaneProps) {
  const { symbol } = usePaneTickerIdentity();
  // A new underlying starts over rather than relabelling the last one's data.
  return symbol ? <OptionsPositioningView key={symbol} {...props} symbol={symbol} />
    : <EmptyState title="Choose an option underlying." />;
}

function OptionsPositioningView({ width, height, focused, symbol }: PaneProps & { symbol: string }) {
  const colors = useThemeColors();
  // A pane linked to a watchlist changes underlying with the cursor. The expiry and strike it
  // saved for one would otherwise open the next on the same date, so they are kept per symbol
  // and the last symbol's are dropped.
  const own = (key: string) => `${key}:${symbol}`;
  const pruneState = usePrunePluginPaneState();
  useEffect(() => {
    pruneState((key) => UNDERLYING_STATE_KEY.test(key) && !key.endsWith(`:${symbol}`));
  }, [pruneState, symbol]);
  const [initialTab] = usePaneSettingValue("tab", "strikes");
  const [savedTab, setTab] = usePluginPaneState<string>("opx:tab", initialTab);
  const [initialExpiry] = usePaneSettingValue("expiry", "");
  const [requestedExpiry, setRequestedExpiry] = usePluginPaneState<string | null>(own("opx:expiry"), initialExpiry || null);
  // An expiry the pane was opened with (shot --expiry) applies to gamma too.
  const [gammaExpiry, setGammaExpiry] = usePluginPaneState<string>(own("opx:gammaExpiry"), initialExpiry || ALL_EXPIRIES);
  const [selectedStrike, setSelectedStrike] = usePluginPaneState<string | null>(own("opx:strike"), null);
  const [selectedExpiry, setSelectedExpiry] = usePluginPaneState<string | null>(own("opx:expiryRow"), null);
  const [selectedGammaStrike, setSelectedGammaStrike] = usePluginPaneState<string | null>(own("opx:gammaStrike"), null);
  const [strikeSort, setStrikeSort] = useState<Sort>({ columnId: "strike", direction: "asc" });
  const [expirySort, setExpirySort] = useState<Sort>({ columnId: "date", direction: "asc" });
  const [gammaSort, setGammaSort] = useState<Sort>({ columnId: "strike", direction: "asc" });

  const openInterestLoader = useCallback(
    (_force: boolean) => loadOpenInterest(symbol, requestedExpiry),
    [symbol, requestedExpiry],
  );
  const openInterest = useAsyncResource<OpenInterestPayload>(openInterestLoader, { keepPreviousData: true });
  const data = openInterest.data;
  const spot = data?.spot ?? null;
  const expiries = data?.expiries ?? [];
  const shownExpiry = data?.expiry ?? requestedExpiry;
  const changes = data?.previousOiDate != null;
  const expiryDates = useMemo(() => expiries.map((row) => row.date), [expiries]);

  // VIX options settle on VIX futures, so there is no dealer gamma against the index to show.
  const tabs = useMemo(() => data?.underlying === "VIX"
    ? POSITIONING_TABS.filter((entry) => entry.value !== "gex") : POSITIONING_TABS, [data?.underlying]);
  const tab: PositioningTab = isPositioningTab(savedTab) && tabs.some((entry) => entry.value === savedTab) ? savedTab : "strikes";
  // A saved expiry that has since expired, or was listed for the last underlying, falls back to all of them.
  const gammaChoice = gammaExpiry !== ALL_EXPIRIES && expiryDates.includes(gammaExpiry) ? gammaExpiry : ALL_EXPIRIES;
  // Gamma prices every expiry's chain, so it loads only once its tab is open; a single
  // expiry waits for the listed expiries to say whether it is still there.
  const gammaLoader = useCallback(
    (_force: boolean) => loadGamma(symbol, gammaChoice === ALL_EXPIRIES ? null : gammaChoice),
    [symbol, gammaChoice],
  );
  const gammaReady = tab === "gex" && (!!data || gammaExpiry === ALL_EXPIRIES);
  const gamma = useAsyncResource<GammaPayload>(gammaReady ? gammaLoader : null, { keepPreviousData: true });
  useAutoRefresh(openInterest.updatedAt, openInterest.load, { intervalMs: OPEN_INTEREST_REFRESH_MS });
  useAutoRefresh(gamma.updatedAt, gamma.load, { intervalMs: tab === "gex" ? GAMMA_REFRESH_MS : null });
  usePaneRefreshKey(() => {
    void openInterest.reload();
    if (tab === "gex") void gamma.reload();
  }, { focused });

  // Expiry steps: [ and ] move through the expiries on Strikes and GEX.
  const currentExpiry = tab === "gex" ? (gammaChoice === ALL_EXPIRIES ? null : gammaChoice) : shownExpiry;
  const expiryIndex = currentExpiry ? expiryDates.indexOf(currentExpiry) : -1;
  const stepExpiry = useCallback((step: -1 | 1) => {
    if (tab === "expiries" || !expiryDates.length) return;
    if (tab === "gex") {
      // All sits before the first expiry.
      const next = expiryIndex + step;
      if (next < -1 || next >= expiryDates.length) return;
      setGammaExpiry(next < 0 ? ALL_EXPIRIES : expiryDates[next]!);
      return;
    }
    const next = expiryDates[expiryIndex + step];
    if (next) setRequestedExpiry(next);
  }, [expiryDates, expiryIndex, setGammaExpiry, setRequestedExpiry, tab]);
  useShortcut((event) => {
    if (!focused || event.defaultPrevented || tab === "expiries") return;
    const step = isPlainKey(event, EXPIRY_PREVIOUS_KEY) ? -1 : isPlainKey(event, EXPIRY_NEXT_KEY) ? 1 : 0;
    if (!step) return;
    event.preventDefault();
    event.stopPropagation?.();
    stepExpiry(step);
  });
  // Its own registration: sharing the status footer's id would let an empty menu remove that footer.
  usePaneMenuItems("options-positioning:expiry-steps", () => tab === "expiries" ? [] : [
    { id: "expiry-previous", label: "Previous Expiry", accelerator: EXPIRY_PREVIOUS_KEY,
      enabled: tab === "gex" ? expiryIndex >= 0 : expiryIndex > 0, onSelect: () => stepExpiry(-1) },
    { id: "expiry-next", label: "Next Expiry", accelerator: EXPIRY_NEXT_KEY,
      enabled: expiryIndex < expiryDates.length - 1, onSelect: () => stepExpiry(1) },
  ], [expiryDates.length, expiryIndex, stepExpiry, tab]);

  const { strip: tabStrip, rows: tabRows } = usePaneTabs(data?.expiries.length
    ? { tabs, activeValue: tab, onSelect: (value: string) => setTab(value), focused, dense: true }
    : null);
  const bodyHeight = Math.max(3, height - tabRows);

  // Footer: what the data is (delayed or real time, the OI session), and its gaps.
  const { hint: upgradeHint, segment: accessSegment } = useCloudAccessFooter({
    delayLabel: "15m", focused, segmentId: "opx-access", shortcutScope: "opx:upgrade",
    degraded: (tab === "gex" ? gamma.data?.delayed : data?.delayed) ?? true,
  });
  const info = useMemo<PaneFooterSegment[]>(() => [
    ...(accessSegment ? [accessSegment] : []),
    ...(data?.oiDate ? [{ id: "oi-date", parts: [{ text: `OI as of ${shortDate(data.oiDate)}`, tone: "muted" as const }] }] : []),
    ...(changes && tab !== "gex" ? [{ id: "oi-change", parts: [{ text: `chg since ${shortDate(data!.previousOiDate!)}`, tone: "muted" as const }] }] : []),
  ], [accessSegment, changes, data?.oiDate, data?.previousOiDate, tab]);
  const activeResource = tab === "gex" ? gamma : openInterest;
  usePaneStatusFooter({
    registrationId: "options-positioning",
    loading: activeResource.loading,
    error: activeResource.data ? activeResource.error : null,
    info,
    hints: upgradeHint ? [upgradeHint] : undefined,
  });
  const notices = useMemo(() => [
    ...(data?.warnings ?? []),
    ...(tab === "gex" ? gamma.data?.warnings ?? [] : []),
    ...(tab === "gex" && gamma.data?.missing.length
      ? [`No volatility for ${gamma.data.missing.map(shortDate).join(", ")}; left out of gamma.`] : []),
  ], [data?.warnings, gamma.data, tab]);
  usePaneNoticeFooter({ registrationId: "options-positioning:notices", focused, notices });

  const expiryFilter = (value: string, options: { value: string; label: string }[], onChange: (value: string) => void): QueryBarFilter => ({
    id: "expiry", label: "Exp", inline: true, value, onChange,
    options: options.map((option, index) => ({
      ...option,
      hint: index === options.findIndex((entry) => entry.value === value) - 1 ? EXPIRY_PREVIOUS_KEY
        : index === options.findIndex((entry) => entry.value === value) + 1 ? EXPIRY_NEXT_KEY : undefined,
    })),
  });
  const expiryOptions = useMemo(() => expiries.map((row) => ({ value: row.date, label: expiryLabel(row.date) })), [expiries]);

  // ---- Strikes ----
  const strikes = data?.strikes ?? [];
  const maxPain = expiries.find((row) => row.date === shownExpiry)?.maxPain ?? null;
  const strikeRows = useMemo(() => sortRows(strikes, strikeSort, (row, id) =>
    id === "strike" ? row.strike : (row[id as keyof StrikeOpenInterest] as number | null)), [strikes, strikeSort]);
  const strikeWindow = useMemo(() => chartWindow(strikes, total, spot, [maxPain]), [strikes, spot, maxPain]);
  const strikeChart = useMemo(() => strikeWindow.length >= 3 ? strikeAxis(strikeWindow.map((row) => row.strike)) : null, [strikeWindow]);
  const nearestSpotStrike = useMemo(() => spot == null ? null : strikes.reduce<StrikeOpenInterest | null>((best, row) =>
    !best || Math.abs(row.strike - spot) < Math.abs(best.strike - spot) ? row : best, null), [spot, strikes]);
  const strikeSelectedId = strikeRows.some((row) => strikeKey(row) === selectedStrike) ? selectedStrike!
    : nearestSpotStrike ? strikeKey(nearestSpotStrike) : strikeRows[0] ? strikeKey(strikeRows[0]) : null;
  const strikeWindowKeys = useMemo(() => new Set(strikeWindow.map(strikeKey)), [strikeWindow]);
  const strikeSelection = useChartTableSelection({
    rows: strikeRows, getId: strikeKey, selectedId: strikeSelectedId, onSelect: setSelectedStrike,
    getDate: (row) => strikeChart && strikeWindowKeys.has(strikeKey(row)) ? strikeChart.toDate(row.strike) : null,
    focused, enabled: tab === "strikes",
  });
  const strikeSeries = useMemo(() => strikeChart ? [
    staticSeries(strikeWindow.map((row) => scalarPoint(strikeChart.toDate(row.strike), row.callOI ?? 0)),
      { id: "calls", label: "Call OI", color: colors.positive, style: "columns", calendarSpaced: true }),
    // Puts hang below zero so the two sides of a strike never cover each other.
    staticSeries(strikeWindow.map((row) => scalarPoint(strikeChart.toDate(row.strike), -(row.putOI ?? 0))),
      { id: "puts", label: "Put OI", color: colors.negative, style: "columns", calendarSpaced: true }),
  ] : [], [colors.negative, colors.positive, strikeChart, strikeWindow]);
  const callTotal = expiries.find((row) => row.date === shownExpiry);
  const strikeFigures = useMemo<StatItem[]>(() => !callTotal ? [] : [
    { id: "max-pain", label: "Max pain", value: maxPain == null ? "--" : formatStrike(maxPain), color: colors.warning,
      detail: maxPain == null ? undefined : `${formatDistance(maxPain, spot)} vs spot` },
    { id: "spot", label: "Spot", value: formatLevel(spot) },
    { id: "pc", label: "P/C OI", value: formatRatio(callTotal.putCallRatio) },
    { id: "calls", label: "Call OI", value: formatCompact(callTotal.callOI), color: colors.positive,
      detail: callTotal.callChange == null ? undefined : formatCountChange(callTotal.callChange) },
    { id: "puts", label: "Put OI", value: formatCompact(callTotal.putOI), color: colors.negative,
      detail: callTotal.putChange == null ? undefined : formatCountChange(callTotal.putChange) },
  ], [callTotal, colors.negative, colors.positive, colors.warning, maxPain, spot]);
  const selectedStrikeRow = strikes.find((row) => strikeKey(row) === strikeSelectedId) ?? null;
  const strikeStrip = useMemo<ChartStripSpec | null>(() => strikeWindow.length < 3 ? null : {
    label: "Open interest by strike",
    values: strikeWindow.map(total),
    value: selectedStrikeRow ? `${formatStrike(selectedStrikeRow.strike)} ${formatCompact(total(selectedStrikeRow))}` : "",
    color: colors.textMuted,
  }, [colors.textMuted, selectedStrikeRow, strikeWindow]);
  const renderStrike = useCallback((row: StrikeOpenInterest, column: DataTableColumn): DataTableCell => {
    switch (column.id) {
      case "strike": return {
        text: formatStrike(row.strike), value: row.strike,
        color: row.strike === maxPain ? colors.warning : colors.textBright,
      };
      case "callOI": return { text: formatCount(row.callOI), value: row.callOI, color: colors.positive };
      case "putOI": return { text: formatCount(row.putOI), value: row.putOI, color: colors.negative };
      case "callChange":
      case "putChange": {
        const change = row[column.id];
        return { text: formatCountChange(change), value: change,
          color: change == null || change === 0 ? colors.textMuted : change > 0 ? colors.positive : colors.negative };
      }
      case "payout": return { text: formatPayout(row.payout), value: row.payout, color: colors.textMuted };
      default: return { text: "" };
    }
  }, [colors, maxPain]);

  // ---- Expiries ----
  const expiryRows = useMemo(() => sortRows(expiries, expirySort, (row, id) =>
    id === "date" ? row.date : id === "distance" ? (row.maxPain == null || spot == null ? null : row.maxPain / spot)
      : id === "change" ? (row.callChange == null ? null : row.callChange + (row.putChange ?? 0))
        : (row[id as keyof ExpiryOpenInterest] as number | null)), [expiries, expirySort, spot]);
  const expiryChart = useMemo(() => expiries.length >= 3 ? expiryAxis(expiryDates) : null, [expiries.length, expiryDates]);
  const expirySelectedId = expiryRows.some((row) => row.date === selectedExpiry) ? selectedExpiry!
    : shownExpiry && expiryRows.some((row) => row.date === shownExpiry) ? shownExpiry : expiryRows[0]?.date ?? null;
  const expirySelection = useChartTableSelection({
    rows: expiryRows, getId: expiryKey, selectedId: expirySelectedId, onSelect: setSelectedExpiry,
    getDate: (row) => expiryChart ? expiryChart.toDate(row.date) : null, focused, enabled: tab === "expiries",
  });
  const expirySeries = useMemo(() => expiryChart ? [
    staticSeries(expiries.map((row) => scalarPoint(expiryChart.toDate(row.date), row.callOI)),
      { id: "calls", label: "Call OI", color: colors.positive, style: "columns", calendarSpaced: true }),
    staticSeries(expiries.map((row) => scalarPoint(expiryChart.toDate(row.date), -row.putOI)),
      { id: "puts", label: "Put OI", color: colors.negative, style: "columns", calendarSpaced: true }),
  ] : [], [colors.negative, colors.positive, expiries, expiryChart]);
  const ladderFigures = useMemo<StatItem[]>(() => {
    if (!expiries.length) return [];
    const calls = expiries.reduce((sum, row) => sum + row.callOI, 0);
    const puts = expiries.reduce((sum, row) => sum + row.putOI, 0);
    const change = changes ? expiries.reduce((sum, row) => sum + (row.callChange ?? 0) + (row.putChange ?? 0), 0) : null;
    const largest = expiries.reduce((best, row) => total(row) > total(best) ? row : best);
    return [
      { id: "oi", label: "Open interest", value: formatCompact(calls + puts),
        detail: change == null ? undefined : formatCountChange(change),
        split: [{ id: "calls", value: calls, color: colors.positive }, { id: "puts", value: puts, color: colors.negative }] },
      { id: "pc", label: "P/C OI", value: formatRatio(calls > 0 ? puts / calls : null) },
      { id: "largest", label: "Largest expiry", value: expiryLabel(largest.date), detail: formatCompact(total(largest)) },
      { id: "spot", label: "Spot", value: formatLevel(spot) },
    ];
  }, [changes, colors.negative, colors.positive, expiries, spot]);
  const selectedExpiryRow = expiries.find((row) => row.date === expirySelectedId) ?? null;
  const expiryStrip = useMemo<ChartStripSpec | null>(() => expiries.length < 3 ? null : {
    label: "Open interest by expiry",
    values: expiries.map(total),
    value: selectedExpiryRow ? `${expiryLabel(selectedExpiryRow.date)} ${formatCompact(total(selectedExpiryRow))}` : "",
    color: colors.textMuted,
  }, [colors.textMuted, expiries, selectedExpiryRow]);
  const renderExpiry = useCallback((row: ExpiryOpenInterest, column: DataTableColumn): DataTableCell => {
    switch (column.id) {
      case "date": return { text: expiryLabel(row.date), value: row.date, color: colors.textBright };
      case "days": return { text: String(row.days), value: row.days, color: colors.textMuted };
      case "callOI": return { text: formatCount(row.callOI), value: row.callOI, color: colors.positive };
      case "putOI": return { text: formatCount(row.putOI), value: row.putOI, color: colors.negative };
      case "putCallRatio": return { text: formatRatio(row.putCallRatio), value: row.putCallRatio };
      case "change": {
        const change = row.callChange == null ? null : row.callChange + (row.putChange ?? 0);
        return { text: formatCountChange(change), value: change,
          color: change == null || change === 0 ? colors.textMuted : change > 0 ? colors.positive : colors.negative };
      }
      case "maxPain": return { text: row.maxPain == null ? "--" : formatStrike(row.maxPain), value: row.maxPain, color: colors.warning };
      case "distance": return {
        text: formatDistance(row.maxPain, spot),
        value: row.maxPain == null || spot == null ? null : Number(((row.maxPain / spot - 1) * 100).toFixed(4)),
        color: colors.textMuted,
      };
      default: return { text: "" };
    }
  }, [colors, spot]);

  // ---- GEX ----
  const gammaData = gamma.data;
  const gammaSpot = gammaData?.spot ?? null;
  const gammaStrikes = gammaData?.strikes ?? [];
  const gammaRows = useMemo(() => sortRows(gammaStrikes, gammaSort, (row, id) =>
    id === "distance" ? row.strike : id === "puts" ? -row.puts : (row[id as keyof GammaStrike] as number)), [gammaStrikes, gammaSort]);
  const gammaWindow = useMemo(() => chartWindow(gammaStrikes, (row) => Math.abs(row.net), gammaSpot, [gammaData?.flip]),
    [gammaData?.flip, gammaSpot, gammaStrikes]);
  const gammaChart = useMemo(() => gammaWindow.length >= 3 ? strikeAxis(gammaWindow.map((row) => row.strike)) : null, [gammaWindow]);
  const nearestGammaStrike = useMemo(() => gammaSpot == null ? null : gammaStrikes.reduce<GammaStrike | null>((best, row) =>
    !best || Math.abs(row.strike - gammaSpot) < Math.abs(best.strike - gammaSpot) ? row : best, null), [gammaSpot, gammaStrikes]);
  const gammaSelectedId = gammaRows.some((row) => strikeKey(row) === selectedGammaStrike) ? selectedGammaStrike!
    : nearestGammaStrike ? strikeKey(nearestGammaStrike) : gammaRows[0] ? strikeKey(gammaRows[0]) : null;
  const gammaWindowKeys = useMemo(() => new Set(gammaWindow.map(strikeKey)), [gammaWindow]);
  const gammaSelection = useChartTableSelection({
    rows: gammaRows, getId: strikeKey, selectedId: gammaSelectedId, onSelect: setSelectedGammaStrike,
    getDate: (row) => gammaChart && gammaWindowKeys.has(strikeKey(row)) ? gammaChart.toDate(row.strike) : null,
    focused, enabled: tab === "gex",
  });
  const gammaSeries = useMemo(() => gammaChart ? [
    staticSeries(gammaWindow.map((row) => scalarPoint(gammaChart.toDate(row.strike), row.net)), {
      id: "net", label: "Net GEX", color: colors.positive, negativeColor: colors.negative, style: "columns", calendarSpaced: true,
    }),
  ] : [], [colors.negative, colors.positive, gammaChart, gammaWindow]);
  const band = gammaData?.band;
  const shares = band ? `${Math.round(band.shareLow * 100)}-${Math.round(band.shareHigh * 100)}%` : "";
  const gammaFigures = useMemo<StatItem[]>(() => !gammaData?.total ? [] : [
    { id: "net", label: "Net GEX", value: formatGamma(gammaData.total.net), detail: "$ per 1% move",
      color: gammaData.total.net >= 0 ? colors.positive : colors.negative },
    { id: "flip", label: "Flip", value: formatLevel(gammaData.flip),
      detail: gammaData.flip == null ? "none within 15%" : `${formatDistance(gammaData.flip, gammaSpot)} vs spot` },
    ...(band ? [{ id: "band", label: "Dealer range", value: `${formatGamma(band.low)} to ${formatGamma(band.high)}`,
      detail: `${shares} with dealers` }] : []),
    { id: "spot", label: "Spot", value: formatLevel(gammaSpot) },
  ], [band, colors.negative, colors.positive, gammaData, gammaSpot, shares]);
  // The assumption rides in the legend, where the numbers it changes are read; the
  // dealer range figure names its own share. It gives way before the series name does.
  const assumption = width >= 60 ? "dealers long calls, short puts" : width >= 48 ? "long calls, short puts" : null;
  const selectedGammaRow = gammaStrikes.find((row) => strikeKey(row) === gammaSelectedId) ?? null;
  const gammaStrip = useMemo<ChartStripSpec | null>(() => gammaWindow.length < 3 ? null : {
    label: "Net GEX by strike",
    values: gammaWindow.map((row) => row.net),
    value: selectedGammaRow ? `${formatStrike(selectedGammaRow.strike)} ${formatGamma(selectedGammaRow.net)}` : "",
    color: colors.textMuted,
  }, [colors.textMuted, gammaWindow, selectedGammaRow]);
  const renderGamma = useCallback((row: GammaStrike, column: DataTableColumn): DataTableCell => {
    switch (column.id) {
      case "strike": return { text: formatStrike(row.strike), value: row.strike, color: colors.textBright };
      case "calls": return { text: formatGamma(row.calls), value: row.calls, color: colors.positive };
      case "puts": return { text: formatGamma(-row.puts), value: -row.puts, color: colors.negative };
      case "net": return { text: formatGamma(row.net), value: row.net, color: row.net >= 0 ? colors.positive : colors.negative };
      case "distance": return {
        text: formatDistance(row.strike, gammaSpot),
        value: gammaSpot == null ? null : Number(((row.strike / gammaSpot - 1) * 100).toFixed(4)),
        color: colors.textMuted,
      };
      default: return { text: "" };
    }
  }, [colors, gammaSpot]);

  const strikeColumnList = useMemo(() => strikeColumns(changes), [changes]);
  const expiryColumnList = useMemo(() => expiryColumns(changes), [changes]);
  const markerColor = colors.textBright;

  let content: ReactNode = null;
  if (tab === "strikes") {
    const query = <QueryBar width={width} filters={[expiryFilter(shownExpiry ?? "", expiryOptions, setRequestedExpiry)]} />;
    content = <DataTableView columns={strikeColumnList} items={strikeRows} focused={focused}
      rootWidth={width} rootHeight={bodyHeight} getItemKey={strikeKey} renderCell={renderStrike}
      selectedTextOverridesCellColor resetScrollKey={shownExpiry ?? ""}
      selection={{ kind: "id", selectedId: strikeSelectedId, getId: strikeKey, onChange: (id) => setSelectedStrike(id) }}
      onActivate={(row) => setSelectedStrike(strikeKey(row))}
      sortColumnId={strikeSort.columnId} sortDirection={strikeSort.direction}
      onHeaderClick={(id) => setStrikeSort((current) => nextHeaderSort(current, id))}
      emptyStateTitle="No open interest on this expiry."
      getExportMetadata={() => [["expiry", shownExpiry ?? ""], ["open interest as of", data?.oiDate ?? ""],
        ["change since", data?.previousOiDate ?? ""], ["spot", spot ?? ""], ["max pain", maxPain ?? ""]]}
      rootBefore={<ChartTableHeader width={width} height={bodyHeight} query={query} figures={strikeFigures}
        tableRows={strikeRows.length} tableChromeRows={chartTableChromeRows(strikeColumnList, width)}
        chart={strikeChart ? {
          render: (size) => <PositioningChart width={size.width} height={size.height} series={strikeSeries}
            ticks={strikeChart.ticks}
            markers={[
              { id: "spot", ratio: spot == null ? null : strikeChart.ratio(spot), label: "spot", color: markerColor },
              { id: "max-pain", ratio: maxPain == null ? null : strikeChart.ratio(maxPain), label: "max pain", color: colors.warning },
            ]}
            formatCursor={(ratio) => formatStrike(nearestStrike(strikeWindow, strikeChart.at(ratio)))}
            formatValue={(value) => formatCount(Math.abs(value))}
            formatAxisValue={(value, domain) => formatCompactAxis(Math.abs(value), domain)}
            selection={strikeSelection} remoteKind="opx-strikes" />,
          minRows: CHART_MIN_ROWS,
          strip: strikeStrip,
        } : null} />} />;
  } else if (tab === "expiries") {
    content = <DataTableView columns={expiryColumnList} items={expiryRows} focused={focused}
      rootWidth={width} rootHeight={bodyHeight} getItemKey={expiryKey} renderCell={renderExpiry}
      selectedTextOverridesCellColor
      selection={{ kind: "id", selectedId: expirySelectedId, getId: expiryKey, onChange: (id) => setSelectedExpiry(id) }}
      // Enter opens the expiry's strikes.
      onActivate={(row) => { setRequestedExpiry(row.date); setTab("strikes"); }}
      sortColumnId={expirySort.columnId} sortDirection={expirySort.direction}
      onHeaderClick={(id) => setExpirySort((current) => nextHeaderSort(current, id))}
      emptyStateTitle="No listed expiries."
      getExportMetadata={() => [["open interest as of", data?.oiDate ?? ""], ["change since", data?.previousOiDate ?? ""], ["spot", spot ?? ""]]}
      rootBefore={<ChartTableHeader width={width} height={bodyHeight} figures={ladderFigures}
        tableRows={expiryRows.length} tableChromeRows={chartTableChromeRows(expiryColumnList, width)}
        chart={expiryChart ? {
          render: (size) => <PositioningChart width={size.width} height={size.height} series={expirySeries}
            ticks={expiryChart.ticks} markers={[]}
            formatCursor={(ratio) => {
              const date = expiryChart.at(ratio);
              return date ? expiryLabel(date) : "";
            }}
            formatValue={(value) => formatCount(Math.abs(value))}
            formatAxisValue={(value, domain) => formatCompactAxis(Math.abs(value), domain)}
            selection={expirySelection} remoteKind="opx-expiries" />,
          minRows: CHART_MIN_ROWS - 1,
          strip: expiryStrip,
        } : null} />} />;
  } else {
    const query = <QueryBar width={width} filters={[expiryFilter(gammaChoice,
      [{ value: ALL_EXPIRIES, label: "All" }, ...expiryOptions], setGammaExpiry)]} />;
    // The expiry choice stays put while gamma loads or has nothing to show.
    content = !gammaData?.total ? <>
      {query}
      <PaneStatusBody loading={gamma.loading && !gammaData} error={!gammaData ? gamma.error : null}
        subject="dealer gamma" empty={!!gammaData} emptyTitle="No dealer gamma." />
    </> : <DataTableView columns={GAMMA_COLUMNS} items={gammaRows} focused={focused}
            rootWidth={width} rootHeight={bodyHeight} getItemKey={strikeKey} renderCell={renderGamma}
            selectedTextOverridesCellColor resetScrollKey={gammaChoice}
            selection={{ kind: "id", selectedId: gammaSelectedId, getId: strikeKey, onChange: (id) => setSelectedGammaStrike(id) }}
            onActivate={(row) => setSelectedGammaStrike(strikeKey(row))}
            sortColumnId={gammaSort.columnId} sortDirection={gammaSort.direction}
            onHeaderClick={(id) => setGammaSort((current) => nextHeaderSort(current, id))}
            emptyStateTitle="No dealer gamma."
            getExportMetadata={() => [["unit", "dollars of dealer delta per 1% move"],
              ["assumption", "dealers long calls, short puts"], ["expiry", gammaData.expiry ?? "all"],
              ["range low", band?.low ?? ""], ["range high", band?.high ?? ""], ["flip", gammaData.flip ?? ""],
              ["open interest as of", gammaData.oiDate ?? ""], ["quotes as of", gammaData.quotesAsOf ?? ""]]}
            rootBefore={<ChartTableHeader width={width} height={bodyHeight} query={query} figures={gammaFigures}
              tableRows={gammaRows.length} tableChromeRows={chartTableChromeRows(GAMMA_COLUMNS, width)}
              chart={gammaChart ? {
                render: (size) => <PositioningChart width={size.width} height={size.height} series={gammaSeries}
                  ticks={gammaChart.ticks}
                  markers={[
                    { id: "spot", ratio: gammaSpot == null ? null : gammaChart.ratio(gammaSpot), label: "spot", color: markerColor },
                    { id: "flip", ratio: gammaData.flip == null ? null : gammaChart.ratio(gammaData.flip), label: "flip", color: colors.warning },
                  ]}
                  formatCursor={(ratio) => formatStrike(nearestStrike(gammaWindow, gammaChart.at(ratio)))}
                  formatValue={formatGamma} formatAxisValue={formatCompactAxis}
                  legendAccessory={assumption ? <Text fg={colors.textMuted}>{assumption}</Text> : undefined}
                  legendAccessoryWidth={assumption?.length}
                  selection={gammaSelection} remoteKind="opx-gex" />,
                minRows: CHART_MIN_ROWS,
                strip: gammaStrip,
              } : null} />} />;
  }

  return <Box width={width} height={height} flexDirection="column">
    <PaneStatusBody loading={openInterest.loading && !data} error={!data ? openInterest.error : null}
      empty={!!data && !data.expiries.length} subject="open interest"
      emptyTitle={`No listed options for ${positioningSymbol(symbol).replace(/^\^/, "")}.`}>
      {data?.expiries.length ? <>
        {tabStrip}
        {content}
      </> : null}
    </PaneStatusBody>
  </Box>;
}

function nearestStrike(rows: readonly { strike: number }[], value: number): number {
  return rows.reduce((best, row) => Math.abs(row.strike - value) < Math.abs(best - value) ? row.strike : best, rows[0]?.strike ?? value);
}
