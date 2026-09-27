import { useCallback, useMemo, useRef, useState } from "react";
import { Box, Text, useUiCapabilities } from "../../../ui";
import { useThemeColors } from "../../../theme/theme-context";
import { useShortcut } from "../../../react/input";
import { DataTableView } from "../../data-table/view";
import { EmptyState } from "../../ui";
import { displayWidth, truncateToDisplayWidth } from "../../../utils/format";
import { CompositeChart } from "../composite/composite-chart";
import type { CompositeAxisValueFormatter } from "../composite/format";
import {
  buildCurveChart, curveLegendLayout, curveLegendText, curveLookbackLabel, curvePlotWidth, curvePrimarySeries, curveTableRows,
  isCurveRowSeries, type CurvePoint, type CurveSeries, type CurveTableRow, type CurveXScale,
} from "./model";

export interface CurveSlopeReadout {
  label: string;
  value: number | null;
  percentile?: number | null;
  window?: string;
  asOf?: string | null;
  formatValue?: (value: number) => string;
}

export interface CurveSurfaceProps {
  series: readonly CurveSeries[];
  width: number;
  height: number;
  focused?: boolean;
  primarySeriesId?: string;
  selectedPointId?: string | null;
  onSelectedPointChange?: (id: string, point: CurvePoint) => void;
  /** "auto" draws the chart and falls back to the table when the chart has no
   * room; "chart" draws nothing then, for callers that list the points below. */
  display?: "auto" | "chart" | "table" | "both";
  /** What the curve plots, dim at the start of the legend row ("Yield % by maturity"). */
  caption?: string;
  /** "log" spreads maturities from a month to decades; "even" gives every row one slot. */
  xScale?: CurveXScale;
  formatValue?: (value: number) => string;
  /** A ghost in the readout: the primary minus the ghost at the row. Defaults to a signed `formatValue`. */
  formatChange?: (change: number) => string;
  /** Gridline labels; defaults to formatValue. */
  formatAxisValue?: CompositeAxisValueFormatter;
  /** @deprecated The cursor badge shows the row label. */
  formatX?: (value: number) => string;
  valueLabel?: string;
  slope?: CurveSlopeReadout;
}

interface LegendItem { id: string; text: string; color: string | undefined }

const PANELS = [{ id: "main" }];
const formatNumber = (value: number) => value.toFixed(2);
const rowKey = (row: CurveTableRow) => row.id;
const sourceTime = (value: string) => value.replace("T", " ").slice(0, 16);
const READOUT_GAP = "  ";

/** A flat series (a policy rate drawn across the curve) is context, not a reading. */
function isConstant(entry: CurveSeries): boolean {
  const values = entry.points.flatMap((point) => point.value != null && Number.isFinite(point.value) ? [point.value] : []);
  return values.length > 1 && values.every((value) => value === values[0]);
}

/** One numeric-axis curve surface across terminal bitmap, text and desktop.
 * Each ghost owns its coordinates and nulls, so missing months stay gaps. */
export function CurveSurface({ series, width, height, focused = false, primarySeriesId, selectedPointId,
  onSelectedPointChange, display = "auto", caption, xScale, formatValue = formatNumber, formatChange, formatAxisValue,
  slope }: CurveSurfaceProps) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  const [localSelection, setLocalSelection] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const hoverRef = useRef<string | null>(null);
  const pressRef = useRef(false);
  const totalWidth = Math.max(1, Math.floor(width));
  const totalHeight = Math.max(1, Math.floor(height));
  const primary = curvePrimarySeries(series, primarySeriesId);
  const palette = useMemo(() => [colors.positive, colors.textMuted, colors.warning, colors.textDim], [colors]);
  const chart = useMemo(() => buildCurveChart(series, totalWidth, palette, { xScale }), [series, totalWidth, palette, xScale]);
  const rows = useMemo(() => curveTableRows(series), [series]);
  const activeId = selectedPointId === undefined ? localSelection : selectedPointId;
  const selected = rows.find((row) => row.id === activeId);
  const plottedCount = chart.series.reduce((sum, entry) => sum + entry.points.filter((point) => point.value != null).length, 0);
  const colorOf = (id: string) => chart.series.find((row) => row.id === id)?.color;
  const visible = series.filter((entry) => entry.chartVisible !== false);
  const legendRows: LegendItem[][] = [];
  if (caption) {
    // One row: the caption, then the series it draws when there is more than
    // one to tell apart, the primary first, dropping those that do not fit.
    const row: LegendItem[] = [{ id: "caption", text: caption, color: undefined }];
    let used = displayWidth(caption);
    const ordered = primary ? [primary, ...visible.filter((entry) => entry !== primary)] : visible;
    for (const entry of visible.length > 1 ? ordered : []) {
      const text = curveLookbackLabel(entry.label);
      // Two lines that draw one band (a target floor and ceiling) share a label and one entry.
      if (entry.chartVisible === false || row.some((item) => item.text === text)) continue;
      if (used + 3 + displayWidth(text) + 2 > totalWidth - 2) break;
      row.push({ id: entry.id, text, color: colorOf(entry.id) });
      used += 3 + displayWidth(text) + 2;
    }
    legendRows.push(row);
  } else {
    for (const row of curveLegendLayout(series, totalWidth)) {
      legendRows.push(row.map((entry) => ({ id: entry.id, text: curveLegendText(entry), color: colorOf(entry.id) })));
    }
  }
  const showChart = display !== "table" && totalWidth >= 24 && totalHeight >= Math.max(1, legendRows.length) + 6 && plottedCount >= 2;
  const showTable = display === "table" || display === "both" || (display === "auto" && !showChart);
  const legendHeight = showChart ? legendRows.length : 0;
  const slopeHeight = slope && totalHeight > 5 ? 1 : 0;
  const cursorHeight = showChart ? 1 : 0;
  const contentHeight = Math.max(1, totalHeight - legendHeight - slopeHeight - cursorHeight);
  const tableHeight = showTable ? showChart ? Math.min(rows.length + 2, Math.max(3, Math.floor(contentHeight * 0.4))) : contentHeight : 0;
  const chartHeight = showChart ? Math.max(3, contentHeight - tableHeight) : 0;
  const axisFormat = formatAxisValue ?? formatValue;
  // Axis labels are culled at the plot's width, not the surface's: the value
  // gutter takes its labels' width off the right.
  const plotWidth = useMemo(() => showChart ? curvePlotWidth(chart.series, totalWidth, chartHeight - 1, axisFormat) : totalWidth,
    [axisFormat, chart.series, chartHeight, showChart, totalWidth]);
  const select = useCallback((row: CurveTableRow) => {
    setLocalSelection(row.id);
    hoverRef.current = null;
    setHoverId(null);
    const point = (primary && row.points[primary.id]) ?? Object.values(row.points)[0];
    if (point) onSelectedPointChange?.(row.id, point);
  }, [onSelectedPointChange, primary]);
  const nearestRow = useCallback((ratio: number) => rows.reduce<CurveTableRow | null>((best, row) => (
    best == null || Math.abs(chart.ratioOf(row.x) - ratio) < Math.abs(chart.ratioOf(best.x) - ratio) ? row : best
  ), null), [chart, rows]);
  useShortcut((event) => {
    if (!focused || showTable || !showChart || event.ctrl || event.meta || event.shift || event.targetEditable) return;
    const offset = event.name === "left" ? -1 : event.name === "right" ? 1 : 0;
    if (!offset || !rows.length) return;
    event.preventDefault();
    event.stopPropagation?.();
    const index = rows.findIndex((row) => row.id === activeId);
    select(rows[Math.max(0, Math.min(rows.length - 1, index < 0 ? 0 : index + offset))]!);
  });
  // The pointer snaps to the nearest row, so the crosshair, the badge and the
  // readout always name the same maturity.
  const onCursorDateChange = useCallback((date: Date | null) => {
    const row = date == null ? null : nearestRow(chart.dateRatio(date));
    hoverRef.current = row?.id ?? null;
    setHoverId(hoverRef.current);
    if (pressRef.current && row) {
      pressRef.current = false;
      select(row);
    }
  }, [chart, nearestRow, select]);
  // A press activates the chart before it moves the cursor: select the row
  // under the pointer, or the one the press is about to report.
  const onActivate = useCallback(() => {
    const row = rows.find((entry) => entry.id === hoverRef.current);
    if (row) {
      select(row);
      return;
    }
    pressRef.current = true;
    queueMicrotask(() => { pressRef.current = false; });
  }, [rows, select]);
  const hovered = rows.find((row) => row.id === hoverId) ?? null;
  const cursorTarget = hovered ?? selected ?? null;
  const cursorDate = cursorTarget ? chart.toDate(cursorTarget.x) : null;
  // With nothing hovered or selected, the readout shows the primary curve's
  // last point rather than a blank row.
  const cursorRow = cursorTarget
    ?? rows.findLast((row) => primary != null && row.points[primary.id]?.value != null) ?? null;
  const xAxis = useMemo(() => ({
    ticks: chart.ticksAt(plotWidth),
    formatCursor: (ratio: number) => nearestRow(ratio)?.label ?? "",
  }), [chart, nearestRow, plotWidth]);
  const rowAsOf = useCallback((row: CurveTableRow) => (
    (primary && row.points[primary.id]?.asOf) ?? primary?.asOf ?? "--"
  ), [primary]);
  // One shared date is already in the legend or the pane footer; a column
  // repeating it on every row only earns its width when the rows differ.
  const mixedDates = useMemo(() => new Set(rows.map(rowAsOf)).size > 1, [rowAsOf, rows]);
  const tableSeries = useMemo(() => series.filter(isCurveRowSeries), [series]);
  const columns = useMemo(() => [
    { id: "label", label: "Tenor", width: Math.max(10, Math.min(18, Math.floor(totalWidth / 4))), align: "left" as const },
    ...tableSeries.map((entry) => ({ id: entry.id, label: entry.label, width: Math.max(9, Math.min(15, Math.floor((totalWidth - 24) / Math.max(1, tableSeries.length)))), align: "right" as const })),
    ...(mixedDates ? [{ id: "asOf", label: "As of", width: 10, align: "left" as const }] : []),
  ], [mixedDates, tableSeries, totalWidth]);
  const renderCell = useCallback((row: CurveTableRow, column: { id: string }) => {
    if (column.id === "label") return { text: row.label };
    if (column.id === "asOf") return { text: rowAsOf(row), color: colors.textMuted };
    const point = row.points[column.id];
    return { text: point?.value != null && Number.isFinite(point.value) ? formatValue(point.value) : "--" };
  }, [colors.textMuted, formatValue, rowAsOf]);
  const readout = useMemo(() => {
    if (!cursorRow) return [];
    const value = primary ? cursorRow.points[primary.id]?.value : null;
    const change = formatChange ?? ((delta: number) => `${delta > 0 ? "+" : delta < 0 ? "-" : ""}${formatValue(Math.abs(delta))}`);
    const parts = [{ label: cursorRow.label, value: value == null || !Number.isFinite(value) ? "--" : formatValue(value) }];
    // Look-backs read as how far the curve moved since; a flat reference is
    // the same everywhere, so it is drawn and named but never read out.
    for (const entry of series) {
      if (entry === primary || !isCurveRowSeries(entry) || entry.role === "primary" || isConstant(entry)) continue;
      const past = cursorRow.points[entry.id]?.value;
      if (value == null || past == null || !Number.isFinite(value) || !Number.isFinite(past)) continue;
      parts.push({ label: curveLookbackLabel(entry.label), value: change(value - past) });
    }
    return parts;
  }, [cursorRow, formatChange, formatValue, primary, series]);
  if (!rows.length) return <EmptyState title="No curve observations." />;
  if (!showChart && !showTable) return null;
  // The readout keeps the row and its value, then as many look-backs as fit.
  const readoutRoom = Math.max(0, totalWidth - 2);
  const shownReadout: typeof readout = [];
  let readoutUsed = 0;
  for (const [index, part] of readout.entries()) {
    const partWidth = displayWidth(part.label) + 1 + displayWidth(part.value) + (index ? READOUT_GAP.length : 0);
    if (index > 0 && readoutUsed + partWidth > readoutRoom) break;
    shownReadout.push(part);
    readoutUsed += partWidth;
  }
  return <Box width={totalWidth} height={totalHeight} flexDirection="column" overflow="hidden">
    {showChart ? legendRows.map((row, index) => <Box key={index} height={1} flexShrink={0} paddingX={1} gap={3} flexDirection="row" overflow="hidden">
      {row.map((entry) => entry.id === "caption" && caption
        ? <Text key={entry.id} fg={colors.textDim}>{entry.text}</Text>
        : caption
          ? <Box key={entry.id} flexDirection="row" flexShrink={0} alignItems="center">
            {/* The desktop draws the marker as a dot, never a cell character. */}
            {nativePaneChrome
              ? <Box flexShrink={0} style={{ width: 8, height: 8, marginInlineEnd: 6, borderRadius: 999, backgroundColor: entry.color }} />
              : <Text fg={entry.color}>● </Text>}
            <Text fg={colors.text}>{entry.text}</Text>
          </Box>
          : <Text key={entry.id} fg={entry.color}>{entry.text}</Text>)}
    </Box>) : null}
    {slopeHeight && slope ? <Box height={1} paddingX={1} flexShrink={0}>
      <Text fg={colors.text}>{slope.label} {slope.value == null ? "--" : (slope.formatValue ?? formatValue)(slope.value)}
        {` · ${slope.percentile == null ? "--" : slope.percentile.toFixed(0)} pctl${slope.window ? ` ${slope.window}` : ""}`}
        {slope.asOf ? ` · ${sourceTime(slope.asOf)}` : ""}</Text>
    </Box> : null}
    {/* Left/Right step the rows above, so the chart takes no keys of its own. */}
    {showChart ? <CompositeChart series={chart.series} panels={PANELS} width={totalWidth} height={chartHeight}
      navigable={false} showLegend={false} showTimeAxis xAxis={xAxis}
      formatAxisValue={axisFormat} cursorDate={cursorDate} onCursorDateChange={onCursorDateChange}
      onActivate={onActivate} remoteKind="curve-chart" /> : null}
    {showChart ? <Box height={1} flexShrink={0} paddingX={1} flexDirection="row" overflow="hidden">
      {shownReadout.length ? shownReadout.map((part, index) => <Box key={index} flexDirection="row" flexShrink={index ? 0 : 1}>
        <Text fg={colors.textMuted}>{`${index ? READOUT_GAP : ""}${index ? part.label : truncateToDisplayWidth(part.label, Math.max(1, readoutRoom - displayWidth(part.value) - 1))} `}</Text>
        <Text fg={index ? colors.textMuted : colors.text}>{part.value}</Text>
      </Box>) : <Text fg={colors.textMuted}> </Text>}
    </Box> : null}
    {showTable ? <DataTableView columns={columns} items={rows} focused={focused}
      rootHeight={tableHeight} rootWidth={totalWidth} getItemKey={rowKey} renderCell={renderCell}
      selection={{ kind: "id", selectedId: activeId, getId: rowKey, onChange: (_id, row) => select(row) }}
      onActivate={select} sortColumnId={null} sortDirection="asc"
      emptyStateTitle="No curve observations." /> : null}
  </Box>;
}
