import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChartTableHeader, CurveSurface, curveGhostColors, DataTableView, formatBpAxis, formatPercentAxis, Notice, PaneFooterScope,
  PaneStatusBody, QueryBar, useChartTableSelection, usePaneNoticeFooter, usePaneTabs, type DataTableColumn, type QueryBarFilter,
  type StatItem,
} from "../../../components";
import { curveLookbackLabel, curveStrip, curveSurfaceMinRows } from "../../../components/chart/curve";
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
import { formatPercentileRank } from "../../../utils/format";
import { SERIES_COLORS } from "../../../time-series/resolve";
import type { CurveSeries } from "../../../components/chart/curve";
import { yieldCurveHeadless } from "./headless";
import {
  formatYield, formatYieldChange, yieldCurveChartSeries, yieldDifferenceSeries, yieldTenorRows, type YieldLookbackCurves,
  type YieldTenorRow,
} from "./chart";
import {
  compareDate, curveIdOf, CURVE_OPTIONS, curveSpreadFigures, loadComparePoints, loadCurveData, parseCompareInput,
  parseCurveArgument, type CurveId,
} from "./curves";
import { forwardCurve } from "./forward";
import { loadYieldCurveLookbacks, yieldCurveDate } from "./history";
import { curveAsOf, isYieldObservationDate, type YieldPoint, yieldCurveErrors } from "./treasury-data";
import { loadWorldRows, type WorldRow } from "./world";

type GcTab = "curve" | "world";
const TABS = [{ label: "Curve", value: "curve" }, { label: "World", value: "world" }];
const EMPTY_POINTS: YieldPoint[] = [];
/** What each curve plots, in the legend's first words. */
const CAPTIONS: Partial<Record<CurveId, string>> = {
  "us-real": "Real yield % by maturity",
  "us-breakeven": "Breakeven % by maturity",
  gb: "Zero-coupon yield % by maturity",
};
const YIELD_CAPTION = "Yield % by maturity";
/** A breakeven is not a yield, so its curve and column say what it is. */
const valueName = (curve: CurveId) => curve === "us-breakeven" ? "Breakeven" : "Yield";
const TENOR: DataTableColumn = { id: "tenor", label: "Tenor", width: 7, align: "left" };
const YIELD: DataTableColumn = { id: "yield", label: "Yield", width: 8, align: "right" };
const CHANGE_1D: DataTableColumn = { id: "change1d", label: "1D chg", width: 8, align: "right" };
const LOOKBACK_COLUMNS: DataTableColumn[] = [
  CHANGE_1D,
  { id: "change1w", label: "1W chg", width: 8, align: "right" },
  { id: "change1m", label: "1M chg", width: 8, align: "right" },
];
const FORWARD: DataTableColumn = { id: "forward", label: "1Y fwd", width: 8, align: "right" };
const AS_OF_COLUMN: DataTableColumn = { id: "asOf", label: "As of", width: 12, align: "left" };
const tenorKey = (row: YieldTenorRow) => row.id;
// Left and Right step along the maturities, the way the curve reads.
const tenorPosition = (row: YieldTenorRow) => new Date(row.years * 86_400_000);
const RELATIVE_COMPARE = /^\d+[WMY]$/;
/** A difference in basis points: `+7bp`, `-12bp`. */
const formatBp = (value: number) => {
  const bp = Math.round(value);
  return `${bp > 0 ? "+" : ""}${bp === 0 ? 0 : bp}bp`;
};

/** "1D", "1D and 1W", "1D, 1W and 1M". */
function andList(items: readonly string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0] ?? "";
}

/** The session a curve shows: its one date, else the latest tenor's. */
function curveSession(points: readonly YieldPoint[]): string | null {
  return curveAsOf(points) ?? points.flatMap((point) => isYieldObservationDate(point.asOf) && point.yield != null ? [point.asOf] : [])
    .sort().at(-1) ?? null;
}

/**
 * A query bar field that edits a draft and applies it on Enter; leaving it
 * without Enter puts back what the pane shows.
 */
function useDraftField(applied: string) {
  const [draft, setDraft] = useState(applied);
  const [active, setActive] = useState(false);
  const [focusToken, setFocusToken] = useState(0);
  const inputRef = useRef<InputRenderable>(null);
  useEffect(() => { if (!active) setDraft(applied); }, [active, applied]);
  const focus = useCallback(() => {
    setActive(true);
    setFocusToken((token) => token + 1);
  }, []);
  const leave = useCallback(() => {
    setActive(false);
    // Show the start of the value once the field is left, not the scrolled tail.
    if (inputRef.current?.setCursorOffset) inputRef.current.setCursorOffset(0);
    else if (inputRef.current) inputRef.current.cursorOffset = 0;
    inputRef.current?.blur?.();
  }, []);
  return { draft, setDraft, active, setActive, focusToken, focus, leave, inputRef };
}

export function YieldCurvePane({ focused, width, height }: PaneProps) {
  const [tab, setTab] = usePluginPaneState<GcTab>("yield-curve:tab", "curve");
  const [curveSetting, setCurve] = usePaneSettingValue<string>("curve", "us");
  const curve = curveIdOf(curveSetting) ?? "us";
  const [mounted, setMounted] = useState<ReadonlySet<GcTab>>(() => new Set([tab]));
  useEffect(() => setMounted((previous) => previous.has(tab) ? previous : new Set([...previous, tab])), [tab]);
  const { strip, rows: stripRows } = usePaneTabs({ tabs: TABS, activeValue: tab, onSelect: (value) => setTab(value as GcTab),
    focused, dense: true });
  const bodyHeight = Math.max(1, height - stripRows);
  // A market row opens its curve.
  const openCurve = useCallback((id: CurveId) => {
    setCurve(id);
    setTab("curve");
  }, [setCurve, setTab]);

  return (
    <Box flexDirection="column" width={width} height={height}>
      {strip}
      {(["curve", "world"] as const).map((id) => mounted.has(id) ? (
        <Box key={id} visible={tab === id} flexDirection="column" width={width} height={bodyHeight} flexGrow={1} flexBasis={0}
          overflow="hidden">
          <PaneFooterScope active={tab === id}>
            {id === "curve"
              ? <CurveTab curve={curve} onCurveChange={setCurve} focused={focused && tab === "curve"} width={width} height={bodyHeight} />
              : <WorldTab onOpen={openCurve} focused={focused && tab === "world"} width={width} height={bodyHeight} />}
          </PaneFooterScope>
        </Box>
      ) : null)}
    </Box>
  );
}

function CurveTab({ curve, onCurveChange, focused, width, height }: {
  curve: CurveId;
  onCurveChange: (curve: CurveId) => void;
  focused: boolean;
  width: number;
  height: number;
}) {
  const colors = useThemeColors();
  const [requestedDate, setRequestedDate] = usePaneSettingValue<string>("asOfDate", "");
  const [compareInput, setCompareInput] = usePaneSettingValue<string>("compare", "");
  const [view, setView] = usePluginPaneState<"curve" | "difference">("yield-curve:view", "curve");
  const [showForward, setShowForward] = usePluginPaneState<boolean>("yield-curve:forward", false);
  const [selectedTenor, setSelectedTenor] = usePluginPaneState<string | null>("yield-curve:selected", null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const dateField = useDraftField(requestedDate);
  const compareField = useDraftField(compareInput);
  const editing = dateField.active || compareField.active;

  const loadCurve = useCallback(async () => loadCurveData(curve, requestedDate), [curve, requestedDate]);
  const { data, loading, error, updatedAt: lastUpdated, load } = useAsyncResource(loadCurve);
  // A pending curve or date change must never relabel the previous curve as the new one.
  const current = data?.curve === curve && data.requestedDate === requestedDate ? data : null;
  const points = current?.points ?? EMPTY_POINTS;
  const refreshLatest = useCallback(() => { if (!requestedDate) void load(); }, [requestedDate, load]);
  useAutoRefresh(lastUpdated, refreshLatest);
  const session = curveSession(points);

  // FRED's Treasury curve (the fallback) brings no look-backs: they load after
  // it, once per session, and a refresh of the same session keeps them.
  const fredSession = current && !current.lookbacks ? session : null;
  const loadLookbacks = useCallback(async () => ({ session: fredSession, curves: await loadYieldCurveLookbacks(fredSession!) }), [fredSession]);
  const lookbackResource = useAsyncResource(fredSession ? loadLookbacks : null);
  const fredLookbacks = fredSession && lookbackResource.data?.session === fredSession ? lookbackResource.data.curves : null;
  const lookbackCurves = useMemo<YieldLookbackCurves>(() => current?.lookbacks ?? Object.fromEntries((fredLookbacks ?? [])
    .map((lookback) => [lookback.id, lookback.points])), [current, fredLookbacks]);

  // The compare curve: a date, or a span back from the session shown.
  const comparing = compareInput !== "";
  const compareTarget = comparing && session ? compareDate(compareInput, session) : null;
  const compareKey = compareTarget ? `${curve}:${compareTarget}` : null;
  const loadCompare = useCallback(async () => ({ key: compareKey, points: await loadComparePoints(curve, compareTarget!) }),
    [curve, compareKey, compareTarget]);
  const compareResource = useAsyncResource(compareKey ? loadCompare : null);
  const comparePoints = compareKey && compareResource.data?.key === compareKey ? compareResource.data.points : null;
  const compareSession = comparePoints ? curveSession(comparePoints) : null;
  // A span keeps its words ("1Y ago"); a date names the session actually found.
  const compareLabel = RELATIVE_COMPARE.test(compareInput) ? compareInput : compareSession ?? compareTarget ?? compareInput;
  const differenceView = comparing && view === "difference";

  const nodes = useMemo(() => points.flatMap((point) => point.yield != null && Number.isFinite(point.yield)
    ? [{ id: point.maturity, years: point.maturityYears, yield: point.yield }] : []), [points]);
  const forwardNodes = useMemo(() => current ? forwardCurve(nodes, current.basis, current.couponsPerYear) : [], [current, nodes]);
  const forward = showForward && !differenceView ? forwardNodes : [];

  const selectDate = (value: string) => {
    try {
      const nextDate = yieldCurveDate(value);
      setRequestedDate(nextDate);
      dateField.setDraft(nextDate);
      setFieldError(null);
      dateField.leave();
      if (nextDate === requestedDate) void load();
    } catch (failure) {
      setFieldError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const selectCompare = (value: string) => {
    try {
      const next = parseCompareInput(value);
      setCompareInput(next);
      compareField.setDraft(next);
      setFieldError(null);
      compareField.leave();
      if (next && next === compareInput) void compareResource.load();
    } catch (failure) {
      setFieldError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  // The [d]ate, [v]s and [c]urrent hints bind their own keys; Esc in a field is the query bar's.
  usePaneRefreshKey(() => {
    void load();
    if (compareKey) void compareResource.load();
    // A manual refresh also retries look-backs that failed; good ones are kept.
    if (fredSession && (lookbackResource.error || fredLookbacks?.some((lookback) => !lookback.points))) void lookbackResource.load();
  }, { focused, enabled: !editing });

  const asOf = curveAsOf(points);
  const sourceError = yieldCurveErrors(points).join("; ");
  // Limitations of a curve that is still drawn sit behind one warning indicator.
  const missingTenors = points.some((point) => point.yield != null)
    ? points.filter((point) => point.yield == null).map((point) => point.maturity) : [];
  // Both look-backs share one request per tenor, so they usually fail together.
  const lookbackFailures = [...new Set((fredLookbacks ?? []).flatMap((lookback) => lookback.points ? [] : [lookback.error]))]
    .map((message) => `${andList((fredLookbacks ?? []).filter((lookback) => lookback.error === message).map((lookback) => lookback.id))} look-back unavailable: ${message}`);
  usePaneNoticeFooter({
    registrationId: "yield-curve:notices",
    notices: [
      !asOf && points.some((point) => point.yield != null) ? "The tenors carry mixed or unknown observation dates, so the curve is not one session." : null,
      missingTenors.length ? `Unavailable tenors: ${missingTenors.join(", ")}.` : null,
      points.some((point) => point.stale) ? "Some tenors are cached values because their refresh failed." : null,
      lookbackResource.error ? `1D, 1W and 1M look-backs unavailable: ${lookbackResource.error}` : null,
      ...lookbackFailures,
      compareKey && compareResource.error ? `Compare curve unavailable: ${compareResource.error}` : null,
    ].filter((notice): notice is string => notice !== null),
    focused,
    enabled: !error && !sourceError,
  });
  usePaneStatusFooter({
    registrationId: "yield-curve",
    loading: loading || (compareKey != null && compareResource.loading && !comparePoints),
    error: error || sourceError || null,
    hints: [
      { id: "date", key: "d", label: "ate", onPress: dateField.focus },
      { id: "compare", key: "v", label: "s", title: "Compare with a date", onPress: compareField.focus },
      ...(requestedDate ? [{ id: "latest", key: "c", label: "urrent", title: "Current Curve", onPress: () => selectDate("") }] : []),
    ],
  });

  const rows = useMemo(() => yieldTenorRows(points, lookbackCurves, { compare: comparePoints, forward }),
    [comparePoints, forward, lookbackCurves, points]);
  // The spreads the desk quotes with their day move and where they sit in the
  // last year; an inverted one is the warning the curve's shape gives.
  const figures = useMemo<StatItem[]>(() => curveSpreadFigures(current, lookbackCurves).map(({ id, value, change1d, percentile1y }) => ({
    id, label: id, value: value == null ? "--" : formatYieldChange(value),
    detail: [`${change1d == null ? "--" : formatYieldChange(change1d)} 1D`,
      ...(percentile1y == null ? [] : [formatPercentileRank(percentile1y, "1Y")])].join(" · "),
    tone: value != null && Math.round(value * 100) < 0 ? "warning" : undefined,
  })), [current, lookbackCurves]);
  const selectedId = rows.some((row) => row.id === selectedTenor) ? selectedTenor! : rows[0]?.id ?? null;
  useChartTableSelection({ rows, getId: tenorKey, getDate: tenorPosition, selectedId, onSelect: setSelectedTenor,
    focused: focused && !editing });
  const compareName = curveLookbackLabel(compareLabel);
  const series = useMemo(() => differenceView
    ? [yieldDifferenceSeries(rows, compareName, { positive: colors.positive, negative: colors.negative })]
    : yieldCurveChartSeries(points, lookbackCurves,
      { current: colors.positive, ghosts: curveGhostColors(colors), compare: colors.warning, forward: colors.borderFocused },
      { compare: comparing ? { label: compareLabel, points: comparePoints ?? [] } : null, forward, label: valueName(curve) }),
  [colors, compareLabel, compareName, comparePoints, comparing, curve, differenceView, forward, lookbackCurves, points, rows]);
  // Mixed tenor dates still draw the curve: the As of column and the footer
  // warning say which tenors differ.
  const mixedDates = new Set(rows.flatMap((row) => row.yield == null ? [] : [row.asOf])).size > 1;
  const columns = useMemo<DataTableColumn[]>(() => [
    TENOR, curve === "us-breakeven" ? { ...YIELD, label: valueName(curve), width: 10 } : YIELD,
    ...(comparing
      ? [{ id: "compare", label: compareName || "vs", width: Math.max(8, compareName.length + 1), align: "right" as const },
        { id: "changeCompare", label: "Chg", width: 8, align: "right" as const }, CHANGE_1D]
      : LOOKBACK_COLUMNS),
    ...(forward.length ? [FORWARD] : []),
    ...(mixedDates ? [AS_OF_COLUMN] : []),
  ], [compareName, comparing, curve, forward.length, mixedDates]);
  const caption = differenceView ? `Change vs ${compareName}` : CAPTIONS[curve] ?? YIELD_CAPTION;
  const formatValue = differenceView ? formatBp : formatYield;
  // The strip's label shares its row with the curve's shape and the point. A
  // curve with fewer than two yields has neither, so the tenors take the band.
  const strip = curveStrip(series, formatValue, { caption: differenceView ? "Change" : "Yield %", selectedPointId: selectedId });
  const renderCell = useCallback((row: YieldTenorRow, column: DataTableColumn) => {
    if (column.id === "tenor") return { text: row.id };
    if (column.id === "asOf") return { text: row.asOf ?? "--", color: colors.textMuted };
    const value = row[column.id as "yield" | "compare" | "forward" | "change1d" | "change1w" | "change1m" | "changeCompare"];
    if (value == null) return { text: "--", color: colors.textMuted };
    if (column.id === "yield" || column.id === "compare" || column.id === "forward") return { text: formatYield(value) };
    // Colour follows the shown basis points, so a move that rounds to 0bp stays neutral.
    return { text: formatYieldChange(value), color: priceColor(Math.round(value * 100), colors) };
  }, [colors]);

  const textField = (field: ReturnType<typeof useDraftField>, id: string, label: string, placeholder: string,
    apply: (value: string) => void, applied: string): QueryBarFilter => ({
    id, kind: "text", label, value: field.draft, placeholder, width: 10, debounceMs: 0, focused,
    active: field.active, onActiveChange: field.setActive, focusToken: field.focusToken, inputRef: field.inputRef,
    // Typing only edits the draft; Enter applies it. Clearing the chip
    // (outside the field) turns it back to its default.
    onChange: (value: string) => {
      field.setDraft(value);
      if (!field.active && !value.trim() && applied) apply("");
    },
    onSubmit: apply,
  });
  const queryBar = (
    <QueryBar
      width={width}
      filters={[
        { id: "curve", label: "Curve", value: curve, options: CURVE_OPTIONS.map((option) => ({ value: option.id, label: option.label })),
          onChange: (value: CurveId) => onCurveChange(value) },
        textField(dateField, "date", "Date", "latest", selectDate, requestedDate),
        textField(compareField, "compare", "vs", "date or 1Y", selectCompare, compareInput),
        // Picks what is drawn rather than narrowing it, so it has no reset.
        ...(comparing ? [{ id: "view", label: "View", inline: true, value: differenceView ? "difference" : "curve",
          options: [{ value: "curve", label: "Curves" }, { value: "difference", label: "Diff" }],
          onChange: (value: "curve" | "difference") => setView(value) }] : []),
        ...(forwardNodes.length && !differenceView ? [{ id: "forward", kind: "toggle" as const, label: "1Y fwd", value: showForward,
          onChange: setShowForward }] : []),
      ]}
      // The session actually shown; a requested date the field already shows is not repeated.
      meta={asOf && asOf !== requestedDate ? `as of ${asOf}` : undefined}
    />
  );
  // The query bar stays above the status body so the curve or date can change
  // while a curve loads or after one fails; the chart and the tenors share the rest.
  const bodyHeight = Math.max(1, height - 1 - (fieldError ? 1 : 0));

  return (
    <Box flexDirection="column" width={width} height={height}>
      {queryBar}
      {fieldError ? <Notice tone="negative">{fieldError}</Notice> : null}
      <PaneStatusBody loading={loading && points.length === 0} error={points.length === 0 ? error : null}
        loadingLabel="Loading yield curve..." subject="yield curve">
        <DataTableView<YieldTenorRow>
          focused={focused && !editing} rootWidth={width} rootHeight={bodyHeight}
          columns={columns} items={rows} getItemKey={tenorKey} renderCell={renderCell}
          selection={{ kind: "id", selectedId, getId: tenorKey, onChange: (id) => setSelectedTenor(id) }}
          onActivate={(row) => setSelectedTenor(row.id)} sortColumnId={null} sortDirection="asc"
          emptyStateTitle="No tenors."
          rootBefore={<ChartTableHeader width={width} height={bodyHeight} tableRows={rows.length} tableColumns={columns} figures={figures}
            chart={strip ? {
              render: (size) => <CurveSurface series={series} width={size.width} height={size.height} display="chart"
                caption={caption} xScale={differenceView ? "even" : "log"} formatValue={formatValue} formatChange={formatYieldChange}
                formatAxisValue={differenceView ? formatBpAxis : formatPercentAxis} selectedPointId={selectedId}
                onSelectedPointChange={(id) => setSelectedTenor(id)} />,
              minRows: curveSurfaceMinRows({ series, width, caption }),
              strip,
            } : null} />}
        />
      </PaneStatusBody>
    </Box>
  );
}

const WORLD_COLUMNS: DataTableColumn[] = [
  { id: "market", label: "Market", width: 9, align: "left" },
  { id: "twoYear", label: "2Y", width: 6, align: "right" },
  { id: "twoYearChange", label: "1D", width: 5, align: "right" },
  { id: "tenYear", label: "10Y", width: 6, align: "right" },
  { id: "tenYearChange", label: "1D", width: 5, align: "right" },
  { id: "thirtyYear", label: "30Y", width: 6, align: "right" },
  { id: "thirtyYearChange", label: "1D", width: 5, align: "right" },
  { id: "twosTens", label: "2s10s", width: 6, align: "right" },
  { id: "twosTensChange", label: "1D", width: 5, align: "right" },
  { id: "asOf", label: "As of", width: 10, align: "left" },
];
const worldKey = (row: WorldRow) => row.id;
/** Palette slots far enough apart that six curves on one axis read apart (skips the orange beside yellow). */
const MARKET_COLOR_SLOTS = [0, 1, 2, 3, 4, 7] as const;

/** One row per market, each on the session its publisher last printed. */
function WorldTab({ onOpen, focused, width, height }: {
  onOpen: (curve: CurveId) => void;
  focused: boolean;
  width: number;
  height: number;
}) {
  const colors = useThemeColors();
  const [selected, setSelected] = usePluginPaneState<string | null>("yield-curve:market", null);
  const loadWorld = useCallback(() => loadWorldRows(), []);
  const { data, loading, error, updatedAt, load } = useAsyncResource(loadWorld);
  useAutoRefresh(updatedAt, load);
  usePaneRefreshKey(() => void load(), { focused });
  usePaneStatusFooter({ registrationId: "yield-curve:world", loading, error: error || null });
  const rows = data ?? [];
  const selectedId = rows.some((row) => row.id === selected) ? selected! : rows[0]?.id ?? null;
  // Every market's latest curve, each in its own colour; the selected row is
  // the primary, so the readout gives the others' spread to it at the cursor.
  const series = useMemo<CurveSeries[]>(() => rows.map((row, index) => ({
    id: row.id, label: row.market, role: row.id === selectedId ? "primary" : "ghost",
    color: SERIES_COLORS[MARKET_COLOR_SLOTS[index % MARKET_COLOR_SLOTS.length]!],
    points: row.points.filter((point) => point.years > 0)
      .map((point) => ({ id: point.tenor, label: point.tenor, x: point.years, value: point.yield })),
  })), [rows, selectedId]);
  const strip = curveStrip(series, formatYield, { caption: "Yield %" });
  const renderCell = useCallback((row: WorldRow, column: DataTableColumn) => {
    if (column.id === "market") return { text: row.market };
    if (column.id === "asOf") return { text: row.asOf, color: colors.textMuted };
    const value = row[column.id as "twoYear" | "tenYear" | "thirtyYear" | "twosTens" | "twoYearChange" | "tenYearChange"
      | "thirtyYearChange" | "twosTensChange"];
    if (value == null) return { text: "--", color: colors.textMuted };
    if (column.id === "twoYear" || column.id === "tenYear" || column.id === "thirtyYear") return { text: formatYield(value) };
    const text = formatYieldChange(value);
    // The curve spread is a level in basis points; the day moves carry their sign's colour.
    return column.id === "twosTens"
      ? { text, color: Math.round(value * 100) < 0 ? colors.warning : undefined }
      : { text, color: priceColor(Math.round(value * 100), colors) };
  }, [colors]);
  return (
    <PaneStatusBody loading={loading && !data} error={!data ? error : null} loadingLabel="Loading world curves..." subject="world curves">
      <DataTableView<WorldRow>
        focused={focused} rootWidth={width} rootHeight={height}
        columns={WORLD_COLUMNS} items={rows} getItemKey={worldKey} renderCell={renderCell}
        selection={{ kind: "id", selectedId, getId: worldKey, onChange: (id) => setSelected(id) }}
        onActivate={(row) => onOpen(row.id)} sortColumnId={null} sortDirection="asc"
        emptyStateTitle="No curves yet."
        rootBefore={<ChartTableHeader width={width} height={height} tableRows={rows.length} tableColumns={WORLD_COLUMNS}
          chart={strip ? {
            render: (size) => <CurveSurface series={series} width={size.width} height={size.height} display="chart"
              caption={YIELD_CAPTION} xScale="log" formatValue={formatYield} formatChange={formatYieldChange}
              formatAxisValue={formatPercentAxis} primarySeriesId={selectedId ?? undefined} />,
            minRows: curveSurfaceMinRows({ series, width, caption: YIELD_CAPTION }),
            strip,
          } : null} />}
      />
    </PaneStatusBody>
  );
}

export const yieldCurveModule: PluginModule = {
  panes: [{
    id: "yield-curve",
    name: "Yield Curves",
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
    description: "Government bond curves: US Treasury, TIPS real, breakevens, euro AAA, Bund, Gilt, JGB and Canada, with a world grid.",
    keywords: ["yield", "curve", "treasury", "bonds", "rates", "gc", "interest", "tips", "breakeven", "bund", "gilt", "jgb",
      "sovereign", "world", "forward"],
    shortcut: { prefix: "GC", argPlaceholder: "[curve] [YYYY-MM-DD]", argKind: "text", argOptional: true },
    headless: yieldCurveHeadless,
    createInstance: (_context, options) => {
      const { curve, date } = parseCurveArgument(options?.arg);
      return { settings: { asOfDate: date, ...(curve ? { curve } : {}) } };
    },
  }],
};
