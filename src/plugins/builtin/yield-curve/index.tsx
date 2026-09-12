import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, DataTableView, Notice, PaneStatusBody, StaticChartSurface, TextField, type PaneFooterSegment } from "../../../components";
import { resolveChartPalette } from "../../../components/chart/core/palette";
import { useAsyncResource } from "../../../react/async-resource";
import { useShortcut } from "../../../react/input";
import { usePaneSettingValue } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, ScrollBox, Text, type InputRenderable } from "../../../ui";
import type { PluginModule } from "../plugin-module";
import { useAutoRefresh } from "../shared/auto-refresh";
import { usePaneStatusFooter } from "../shared/pane-footer";
import { yieldCurveHeadless } from "./headless";
import { buildYieldCurveChart } from "./chart";
import { completeYieldCurve, loadHistoricalYieldCurve, yieldCurveDate } from "./history";
import {
  curveAsOf,
  loadYieldCurve,
  parseYieldPoints,
  spreadBasisPoints,
  type YieldPoint,
} from "./treasury-data";

export { yieldCurveHeadless } from "./headless";

const EMPTY_POINTS: YieldPoint[] = [];
const TABLE_COLUMNS = [
  { id: "maturity", label: "Maturity", width: 9, align: "left" as const },
  { id: "yield", label: "Yield", width: 8, align: "right" as const },
  { id: "asOf", label: "As of", width: 11, align: "left" as const },
];

function formatYield(y: number | null): string {
  if (y == null) return "—";
  return `${y.toFixed(2)}%`;
}

function formatYieldAxis(value: number): string {
  return `${value.toFixed(2)}%`;
}

export function YieldCurvePane({ focused, width, height }: PaneProps) {
  const [requestedDate, setRequestedDate] = usePaneSettingValue<string>("asOfDate", "");
  const [draftDate, setDraftDate] = useState(requestedDate);
  const [dateError, setDateError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const dateInput = useRef<InputRenderable>(null);
  useEffect(() => { if (editing) dateInput.current?.focus?.(); }, [editing]);
  useEffect(() => { setDraftDate(requestedDate); }, [requestedDate]);
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
  const selectDate = (value: string) => {
    try {
      const nextDate = yieldCurveDate(value);
      setRequestedDate(nextDate);
      setDraftDate(nextDate);
      setDateError(null);
      setEditing(false);
      if (dateInput.current?.setCursorOffset) dateInput.current.setCursorOffset(0);
      else if (dateInput.current) dateInput.current.cursorOffset = 0;
      dateInput.current?.blur?.();
      if (nextDate === requestedDate) void load();
    } catch (error) {
      setDateError(error instanceof Error ? error.message : String(error));
    }
  };

  useShortcut((ev) => {
    if (!focused || editing) return;
    if (ev.name === "d") {
      ev.preventDefault();
      setEditing(true);
    } else if (ev.name === "r") {
      void load();
    } else if (ev.name === "l") {
      selectDate("");
    }
  });

  const bp = spreadBasisPoints(points);
  // Treasury series are daily closes, so which session the curve represents is
  // status the user needs; "updated Xm ago" only says when we last fetched it.
  const asOf = curveAsOf(points);

  const yieldStatus = useMemo<PaneFooterSegment[]>(() => [
      ...(bp != null ? [{ id: "spread", parts: [{ text: `10Y−2Y ${bp >= 0 ? "+" : ""}${bp}bp`, tone: bp < 0 ? "warning" as const : "muted" as const }] }] : []),
      ...(asOf ? [{ id: "as-of", parts: [{ text: `as of ${asOf}`, tone: "muted" as const }] }] : []),
      ...(requestedDate && requestedDate !== asOf ? [{ id: "requested", parts: [{ text: `requested ${requestedDate}`, tone: "muted" as const }] }] : []),
      ...(!asOf && points.length ? [{ id: "mixed-dates", parts: [{ text: "Mixed or unknown observation dates", tone: "warning" as const }] }] : []),
      ...(points.some((point) => point.yield == null) ? [{ id: "missing", parts: [{ text: "Some tenors unavailable", tone: "warning" as const }] }] : []),
      ...(points.some((point) => point.stale) ? [{ id: "stale", parts: [{ text: "Cached source · refresh failed", tone: "warning" as const }] }] : []),
  ], [asOf, bp, points, requestedDate]);
  usePaneStatusFooter({
    registrationId: "yield-curve",
    loading,
    error,
    info: yieldStatus,
    hints: [
      { id: "date", key: "d", label: "ate", onPress: () => setEditing(true) },
      ...(requestedDate ? [{ id: "latest", key: "l", label: "atest", onPress: () => selectDate("") }] : []),
    ],
  });

  const validPoints = asOf ? parseYieldPoints(points) : [];

  const chartWidth = Math.max(10, width - 2);
  const chartHeight = Math.min(12, Math.max(6, height - 18));

  const palette = resolveChartPalette(colors, "positive");

  const chart = buildYieldCurveChart(validPoints, Math.max(1, chartWidth - 8));

  return (
    <Box flexDirection="column" width={width} height={height}>
      {editing ? <Box flexDirection="row" paddingX={1} gap={1} alignItems="flex-end" flexShrink={0}>
        <TextField label="As-of date" type="date" value={draftDate} width={12}
          placeholder="YYYY-MM-DD" inputRef={dateInput} focused={focused && editing}
          onChange={setDraftDate} onSubmit={selectDate}
          onMouseDown={() => setEditing(true)}
          onKeyDown={(event) => {
            if (event.name === "escape") { setEditing(false); dateInput.current?.blur?.(); }
          }} />
        <Button label="View" onPress={() => selectDate(draftDate)} compact />
      </Box> : null}
      {dateError ? <Notice tone="negative">{dateError}</Notice> : null}
      <PaneStatusBody loading={loading && points.length === 0} error={points.length === 0 ? error : null}
        loadingLabel="Loading yield curve..." subject="yield curve">
      {/* Scrollable chart + table */}
      <ScrollBox flexGrow={1} scrollY focusable={false}>
        <Box flexDirection="column">
          {/* Chart */}
          {chart.points.length >= 2 ? (
            <Box flexDirection="column" paddingX={1} marginTop={1}>
              <StaticChartSurface
                points={chart.points}
                calendarSpaced
                xAxisTicks={chart.ticks}
                formatXAxisCursorValue={chart.formatCursor}
                width={chartWidth}
                height={chartHeight}
                mode="line"
                colors={palette}
                yAxisLabel="Yield (%)"
                yAxisColor={colors.textDim}
                formatYAxisValue={formatYieldAxis}
              />
            </Box>
          ) : (
            <Box paddingX={1} marginTop={1}>
              <Text fg={colors.textMuted}>{points.length && !asOf ? "A curve requires matching observation dates" : "Not enough data for chart"}</Text>
            </Box>
          )}

          <Box marginTop={1} height={12}>
            <DataTableView columns={TABLE_COLUMNS} items={points} selection={{ kind: "none" }}
              focused={focused && !editing} sortColumnId={null} sortDirection="asc" onHeaderClick={() => {}}
              getItemKey={(point) => point.maturity} rootHeight={12} emptyStateTitle="No Treasury observations"
              renderCell={(point, column) => ({ text: column.id === "yield" ? formatYield(point.yield)
                : column.id === "asOf" ? point.asOf ?? "—" : point.maturity })} />
          </Box>
        </Box>
      </ScrollBox>
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
