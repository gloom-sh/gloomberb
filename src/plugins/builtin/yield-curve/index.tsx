import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChartTableHeader, CurveSurface, curveGhostColors, DataTableView, formatPercentAxis, Notice, PaneStatusBody, QueryBar,
  useChartTableSelection, usePaneNoticeFooter, type DataTableColumn, type StatItem,
} from "../../../components";
import { curveStrip, curveSurfaceMinRows } from "../../../components/chart/curve";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource } from "../../../react/async-resource";
import { usePaneSettingValue } from "../../../state/app/context";
import { usePluginPaneState } from "../../../public/react";
import { priceColor } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box, type InputRenderable } from "../../../ui";
import type { PluginModule } from "../plugin-module";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { usePaneStatusFooter } from "../../../components/layout/pane/status-footer";
import { yieldCurveHeadless } from "./headless";
import { formatYield, formatYieldChange, yieldCurveChartSeries, yieldSpreads, yieldTenorRows, type YieldLookbackCurves, type YieldTenorRow } from "./chart";
import { completeYieldCurve, loadHistoricalYieldCurve, loadYieldCurveLookbacks, yieldCurveDate } from "./history";
import {
  curveAsOf,
  isYieldObservationDate,
  loadYieldCurve,
  type YieldPoint,
  yieldCurveErrors,
} from "./treasury-data";


const EMPTY_POINTS: YieldPoint[] = [];
const CAPTION = "Yield % by maturity";
const COLUMNS: DataTableColumn[] = [
  { id: "tenor", label: "Tenor", width: 7, align: "left" },
  { id: "yield", label: "Yield", width: 8, align: "right" },
  { id: "change1d", label: "1D chg", width: 8, align: "right" },
  { id: "change1w", label: "1W chg", width: 8, align: "right" },
  { id: "change1m", label: "1M chg", width: 8, align: "right" },
];
const AS_OF_COLUMN: DataTableColumn = { id: "asOf", label: "As of", width: 12, align: "left" };
const tenorKey = (row: YieldTenorRow) => row.id;
// Left and Right step along the maturities, the way the curve reads.
const tenorPosition = (row: YieldTenorRow) => new Date(row.years * 86_400_000);

/** "1D", "1D and 1W", "1D, 1W and 1M". */
function andList(items: readonly string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0] ?? "";
}

/** The session a curve shows: its one date, else the latest tenor's. */
function curveSession(points: readonly YieldPoint[]): string | null {
  return curveAsOf(points) ?? points.flatMap((point) => isYieldObservationDate(point.asOf) && point.yield != null ? [point.asOf] : [])
    .sort().at(-1) ?? null;
}

export function YieldCurvePane({ focused, width, height }: PaneProps) {
  const colors = useThemeColors();
  const [requestedDate, setRequestedDate] = usePaneSettingValue<string>("asOfDate", "");
  const [selectedTenor, setSelectedTenor] = usePluginPaneState<string | null>("yield-curve:selected", null);
  const [draftDate, setDraftDate] = useState(requestedDate);
  const [dateError, setDateError] = useState<string | null>(null);
  const [dateActive, setDateActive] = useState(false);
  const [dateFocusToken, setDateFocusToken] = useState(0);
  const dateInput = useRef<InputRenderable>(null);
  // Leaving the field without Enter puts back the date the curve shows.
  useEffect(() => { if (!dateActive) setDraftDate(requestedDate); }, [dateActive, requestedDate]);
  const loadCurve = useCallback(async () => ({
    requestedDate,
    points: completeYieldCurve(requestedDate
      ? await loadHistoricalYieldCurve(requestedDate)
      : await loadYieldCurve()),
  }), [requestedDate]);
  const { data, loading, error, updatedAt: lastUpdated, load } = useAsyncResource(loadCurve);
  // A pending date change must never relabel the previous curve as the new one.
  const points = data?.requestedDate === requestedDate ? data.points : EMPTY_POINTS;
  const refreshLatest = useCallback(() => { if (!requestedDate) void load(); }, [requestedDate, load]);
  useAutoRefresh(lastUpdated, refreshLatest);
  // The week- and month-back curves follow the session shown, not the clock,
  // so they load once per session and a refresh of the same session keeps them.
  const session = curveSession(points);
  const loadLookbacks = useCallback(async () => ({ session, curves: await loadYieldCurveLookbacks(session!) }), [session]);
  const lookbackResource = useAsyncResource(session ? loadLookbacks : null);
  const lookbacks = lookbackResource.data?.session === session ? lookbackResource.data.curves : null;
  const lookbackCurves = useMemo<YieldLookbackCurves>(() => Object.fromEntries((lookbacks ?? [])
    .map((lookback) => [lookback.id, lookback.points])), [lookbacks]);
  const selectDate = (value: string) => {
    try {
      const nextDate = yieldCurveDate(value);
      setRequestedDate(nextDate);
      setDraftDate(nextDate);
      setDateError(null);
      setDateActive(false);
      // Show the start of the date once the field is left, not the scrolled tail.
      if (dateInput.current?.setCursorOffset) dateInput.current.setCursorOffset(0);
      else if (dateInput.current) dateInput.current.cursorOffset = 0;
      dateInput.current?.blur?.();
      if (nextDate === requestedDate) void load();
    } catch (error) {
      setDateError(error instanceof Error ? error.message : String(error));
    }
  };
  const editDate = () => {
    setDateActive(true);
    setDateFocusToken((token) => token + 1);
  };

  // The [d]ate and [c]urrent hints bind their own keys; Esc in the date field
  // is the query bar's.
  usePaneRefreshKey(() => {
    void load();
    // A manual refresh also retries look-backs that failed; good ones are kept.
    if (session && (lookbackResource.error || lookbacks?.some((lookback) => !lookback.points))) void lookbackResource.load();
  }, { focused, enabled: !dateActive });

  // Treasury series are daily closes, so which session the curve represents is
  // context the query bar carries; "updated Xm ago" only says when we fetched it.
  const asOf = curveAsOf(points);
  const sourceError = yieldCurveErrors(points).join("; ");

  // Limitations of a curve that is still drawn sit behind one warning indicator.
  const missingTenors = points.filter((point) => point.yield == null).map((point) => point.maturity);
  // Both look-backs share one request per tenor, so they usually fail together.
  const lookbackFailures = [...new Set((lookbacks ?? []).flatMap((lookback) => lookback.points ? [] : [lookback.error]))]
    .map((message) => `${andList((lookbacks ?? []).filter((lookback) => lookback.error === message).map((lookback) => lookback.id))} look-back unavailable: ${message}`);
  usePaneNoticeFooter({
    registrationId: "yield-curve:notices",
    notices: [
      !asOf && points.length ? "The tenors carry mixed or unknown observation dates, so the curve is not one session." : null,
      missingTenors.length ? `Unavailable tenors: ${missingTenors.join(", ")}.` : null,
      points.some((point) => point.stale) ? "Some tenors are cached values because their refresh failed." : null,
      lookbackResource.error ? `1D, 1W and 1M look-backs unavailable: ${lookbackResource.error}` : null,
      ...lookbackFailures,
    ].filter((notice): notice is string => notice !== null),
    focused,
    enabled: !error && !sourceError,
  });
  usePaneStatusFooter({
    registrationId: "yield-curve",
    loading,
    error: error || sourceError || null,
    hints: [
      { id: "date", key: "d", label: "ate", onPress: editDate },
      ...(requestedDate ? [{ id: "latest", key: "c", label: "urrent", title: "Current Curve", onPress: () => selectDate("") }] : []),
    ],
  });

  const rows = useMemo(() => yieldTenorRows(points, lookbackCurves), [lookbackCurves, points]);
  // The spreads the desk quotes, with their day move; an inverted one is the warning the curve's shape gives.
  const figures = useMemo<StatItem[]>(() => yieldSpreads(points, lookbackCurves).map(({ id, spread, change1d }) => ({
    id, label: id, value: spread == null ? "--" : formatYieldChange(spread),
    detail: `${change1d == null ? "--" : formatYieldChange(change1d)} 1D`,
    tone: spread != null && Math.round(spread * 100) < 0 ? "warning" : undefined,
  })), [lookbackCurves, points]);
  const selectedId = rows.some((row) => row.id === selectedTenor) ? selectedTenor! : rows[0]?.id ?? null;
  useChartTableSelection({ rows, getId: tenorKey, getDate: tenorPosition, selectedId, onSelect: setSelectedTenor,
    focused: focused && !dateActive });
  const series = useMemo(() => yieldCurveChartSeries(points, lookbackCurves,
    { current: colors.positive, ghosts: curveGhostColors(colors) }), [colors, lookbackCurves, points]);
  // Mixed tenor dates still draw the curve: the As of column and the footer
  // warning say which tenors differ.
  const mixedDates = new Set(rows.flatMap((row) => row.yield == null ? [] : [row.asOf])).size > 1;
  const columns = mixedDates ? [...COLUMNS, AS_OF_COLUMN] : COLUMNS;
  // The strip's label shares its row with the curve's shape and the point. A
  // curve with fewer than two yields has neither, so the tenors take the band.
  const strip = curveStrip(series, formatYield, { caption: "Yield %", selectedPointId: selectedId });
  const renderCell = useCallback((row: YieldTenorRow, column: DataTableColumn) => {
    const value = column.id === "yield" ? row.yield : column.id === "change1d" ? row.change1d
      : column.id === "change1w" ? row.change1w : column.id === "change1m" ? row.change1m : null;
    if (column.id === "tenor") return { text: row.id };
    if (column.id === "asOf") return { text: row.asOf ?? "--", color: colors.textMuted };
    if (value == null) return { text: "--", color: colors.textMuted };
    // Colour follows the shown basis points, so a move that rounds to 0bp stays neutral.
    return column.id === "yield" ? { text: formatYield(value) }
      : { text: formatYieldChange(value), color: priceColor(Math.round(value * 100), colors) };
  }, [colors]);
  const queryBar = (
    <QueryBar
      width={width}
      filters={[{
        id: "date",
        kind: "text",
        label: "Date",
        value: draftDate,
        placeholder: "latest",
        width: 10,
        debounceMs: 0,
        focused,
        active: dateActive,
        onActiveChange: setDateActive,
        focusToken: dateFocusToken,
        inputRef: dateInput,
        // Typing only edits the draft; Enter applies it. Clearing the chip
        // (outside the field) goes back to the latest session.
        onChange: (value: string) => {
          setDraftDate(value);
          if (!dateActive && !value.trim() && requestedDate) selectDate("");
        },
        onSubmit: selectDate,
      }]}
      // The session actually shown; a requested date the field already shows is not repeated.
      meta={asOf && asOf !== requestedDate ? `as of ${asOf}` : undefined}
    />
  );
  // The query bar stays above the status body so the date can change while a
  // curve loads or after one fails; the chart and the tenors share the rest.
  const bodyHeight = Math.max(1, height - 1 - (dateError ? 1 : 0));

  return (
    <Box flexDirection="column" width={width} height={height}>
      {queryBar}
      {dateError ? <Notice tone="negative">{dateError}</Notice> : null}
      <PaneStatusBody loading={loading && points.length === 0} error={points.length === 0 ? error : null}
        loadingLabel="Loading yield curve..." subject="yield curve">
        <DataTableView<YieldTenorRow>
          focused={focused && !dateActive} rootWidth={width} rootHeight={bodyHeight}
          columns={columns} items={rows} getItemKey={tenorKey} renderCell={renderCell}
          selection={{ kind: "id", selectedId, getId: tenorKey, onChange: (id) => setSelectedTenor(id) }}
          onActivate={(row) => setSelectedTenor(row.id)} sortColumnId={null} sortDirection="asc"
          emptyStateTitle="No Treasury tenors."
          rootBefore={<ChartTableHeader width={width} height={bodyHeight} tableRows={rows.length} figures={figures} chart={strip ? {
            render: (size) => <CurveSurface series={series} width={size.width} height={size.height} display="chart"
              caption={CAPTION} xScale="log" formatValue={formatYield} formatChange={formatYieldChange}
              formatAxisValue={formatPercentAxis} selectedPointId={selectedId}
              onSelectedPointChange={(id) => setSelectedTenor(id)} />,
            minRows: curveSurfaceMinRows({ series, width, caption: CAPTION }),
            strip,
          } : null} />}
        />
      </PaneStatusBody>
    </Box>
  );
}

export const yieldCurveModule: PluginModule = {
  panes: [{
    id: "yield-curve",
    name: "US Treasury Yield Curve",
    icon: "Y",
    component: YieldCurvePane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 80, height: 28 },
  }],
  paneTemplates: [{
    id: "yield-curve-pane",
    paneId: "yield-curve",
    label: "Yield Curve",
    description: "US Treasury yield curve charted from FRED data.",
    keywords: ["yield", "curve", "treasury", "bonds", "rates", "gc", "interest"],
    shortcut: { prefix: "GC", argPlaceholder: "YYYY-MM-DD", argKind: "text", argOptional: true },
    headless: yieldCurveHeadless,
    createInstance: (_context, options) => ({ settings: { asOfDate: yieldCurveDate(options?.arg) } }),
  }],
};
