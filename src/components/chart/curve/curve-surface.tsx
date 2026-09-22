import { useCallback, useMemo, useState } from "react";
import { Box, Text } from "../../../ui";
import { useThemeColors } from "../../../theme/theme-context";
import { useShortcut } from "../../../react/input";
import { DataTableView } from "../../data-table/view";
import { EmptyState } from "../../ui";
import { displayWidth } from "../../../utils/format";
import { CompositeChart } from "../composite/composite-chart";
import { buildCurveChart, curveTableRows, type CurvePoint, type CurveSeries, type CurveTableRow } from "./model";

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
  display?: "chart" | "table" | "both";
  formatValue?: (value: number) => string;
  formatX?: (value: number) => string;
  valueLabel?: string;
  slope?: CurveSlopeReadout;
}

const PANELS = [{ id: "main" }];
const formatNumber = (value: number) => value.toFixed(2);
const rowKey = (row: CurveTableRow) => row.id;
const noop = () => {};
const sourceTime = (value: string) => value.replace("T", " ").slice(0, 16);

/** One numeric-axis curve surface across terminal bitmap, text and desktop.
 * Each ghost owns its coordinates and nulls, so missing months stay gaps. */
export function CurveSurface({ series, width, height, focused = false, primarySeriesId, selectedPointId,
  onSelectedPointChange, display = "chart", formatValue = formatNumber, formatX = formatNumber,
  valueLabel = "Value", slope }: CurveSurfaceProps) {
  const colors = useThemeColors();
  const [localSelection, setLocalSelection] = useState<string | null>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const totalWidth = Math.max(1, Math.floor(width));
  const totalHeight = Math.max(1, Math.floor(height));
  const primary = series.find((entry) => entry.id === primarySeriesId) ?? series[0];
  const chart = useMemo(() => buildCurveChart(series, Math.max(1, totalWidth - 10),
    [colors.positive, colors.textMuted, colors.warning, colors.textDim]), [series, totalWidth, colors]);
  const rows = useMemo(() => curveTableRows(series), [series]);
  const activeId = selectedPointId === undefined ? localSelection : selectedPointId;
  const selected = rows.find((row) => row.id === activeId);
  const plottedCount = chart.series.reduce((sum, entry) => sum + entry.points.filter((point) => point.value != null).length, 0);
  const legendRows: Array<Array<{ id: string; text: string; color: string | undefined }>> = [];
  for (const entry of series) {
    if (entry.chartVisible === false) continue;
    const item = { id: entry.id, text: `${entry.label}${entry.asOf ? ` · ${sourceTime(entry.asOf)}` : ""}`, color: chart.series.find((row) => row.id === entry.id)?.color };
    const last = legendRows.at(-1);
    const used = last?.reduce((sum, cell) => sum + displayWidth(cell.text) + 3, 0) ?? 0;
    if (last && used + displayWidth(item.text) <= totalWidth - 2) last.push(item);
    else legendRows.push([item]);
  }
  const showChart = display !== "table" && totalWidth >= 24 && totalHeight >= Math.max(8, legendRows.length + 6) && plottedCount >= 2;
  const showTable = display !== "chart" || !showChart;
  const legendHeight = showChart ? legendRows.length : 0;
  const slopeHeight = slope && totalHeight > 5 ? 1 : 0;
  const cursorHeight = showChart ? 1 : 0;
  const contentHeight = Math.max(1, totalHeight - legendHeight - slopeHeight - cursorHeight);
  const tableHeight = showTable ? showChart ? Math.min(rows.length + 2, Math.max(3, Math.floor(contentHeight * 0.4))) : contentHeight : 0;
  const chartHeight = showChart ? Math.max(3, contentHeight - tableHeight) : 0;
  const select = useCallback((row: CurveTableRow) => {
    setLocalSelection(row.id);
    setHoverX(null);
    const point = (primary && row.points[primary.id]) ?? Object.values(row.points)[0];
    if (point) onSelectedPointChange?.(row.id, point);
  }, [onSelectedPointChange, primary]);
  useShortcut((event) => {
    if (!focused || showTable || event.ctrl || event.meta || event.shift || event.targetEditable) return;
    const offset = event.name === "left" || event.name === "k" ? -1
      : event.name === "right" || event.name === "j" ? 1 : 0;
    if (!offset || !rows.length) return;
    event.preventDefault();
    event.stopPropagation?.();
    const index = rows.findIndex((row) => row.id === activeId);
    select(rows[Math.max(0, Math.min(rows.length - 1, index < 0 ? 0 : index + offset))]!);
  });
  const cursorX = hoverX ?? selected?.x ?? null;
  const cursorDate = cursorX == null ? null : chart.toDate(cursorX);
  const cursorRow = cursorX == null ? null : rows.reduce<CurveTableRow | null>((best, row) => (
    best == null || Math.abs(row.x - cursorX) < Math.abs(best.x - cursorX) ? row : best
  ), null);
  const onCursorDateChange = useCallback((date: Date | null) => setHoverX(date == null ? null : chart.fromDate(date)), [chart]);
  const xAxis = useMemo(() => ({ ticks: chart.ticks, formatCursor: (ratio: number) => formatX(chart.min + ratio * (chart.max - chart.min)) }), [chart, formatX]);
  const columns = useMemo(() => [
    { id: "label", label: "Tenor", width: Math.max(10, Math.min(18, Math.floor(totalWidth / 4))), align: "left" as const },
    ...series.map((entry) => ({ id: entry.id, label: entry.label, width: Math.max(9, Math.min(15, Math.floor((totalWidth - 24) / Math.max(1, series.length)))), align: "right" as const })),
    { id: "asOf", label: "As of", width: 10, align: "left" as const },
  ], [series, totalWidth]);
  const renderCell = useCallback((row: CurveTableRow, column: { id: string }) => {
    if (column.id === "label") return { text: row.label };
    if (column.id === "asOf") return { text: (primary && row.points[primary.id]?.asOf) ?? primary?.asOf ?? "--", color: colors.textMuted };
    const point = row.points[column.id];
    return { text: point?.value != null && Number.isFinite(point.value) ? formatValue(point.value) : "--" };
  }, [colors.textMuted, formatValue, primary]);
  if (!rows.length) return <EmptyState title="No curve observations." />;
  return <Box width={totalWidth} height={totalHeight} flexDirection="column" overflow="hidden">
    {showChart ? legendRows.map((row, index) => <Box key={index} height={1} flexShrink={0} paddingX={1} gap={3} flexDirection="row">
      {row.map((entry) => <Text key={entry.id} fg={entry.color}>{entry.text}</Text>)}
    </Box>) : null}
    {slopeHeight && slope ? <Box height={1} paddingX={1} flexShrink={0}>
      <Text fg={colors.text}>{slope.label} {slope.value == null ? "--" : (slope.formatValue ?? formatValue)(slope.value)}
        {` · ${slope.percentile == null ? "--" : slope.percentile.toFixed(0)} pctl${slope.window ? ` ${slope.window}` : ""}`}
        {slope.asOf ? ` · ${sourceTime(slope.asOf)}` : ""}</Text>
    </Box> : null}
    {showChart ? <CompositeChart series={chart.series} panels={PANELS} width={totalWidth} height={chartHeight}
      focused={focused && !showTable} navigable={false} showLegend={false} showTimeAxis xAxis={xAxis}
      formatAxisValue={formatValue} cursorDate={cursorDate} onCursorDateChange={onCursorDateChange} remoteKind="curve-chart" /> : null}
    {showChart ? <Box height={1} flexShrink={0} paddingX={1}>
      <Text fg={colors.textMuted}>{cursorRow ? `${cursorRow.label} · ${series.map((entry) => {
        const point = cursorRow.points[entry.id];
        const date = entry.chartVisible === false ? point?.asOf ?? entry.asOf : null;
        return `${entry.label}${date ? ` (${sourceTime(date)})` : ""} ${point?.value == null ? "--" : formatValue(point.value)}`;
      }).join(" · ")}` : " "}</Text>
    </Box> : null}
    {showTable ? <DataTableView columns={columns} items={rows} focused={focused}
      rootHeight={tableHeight} rootWidth={totalWidth} getItemKey={rowKey} renderCell={renderCell}
      selection={{ kind: "id", selectedId: activeId, getId: rowKey, onChange: (_id, row) => select(row) }}
      onActivate={select} sortColumnId={null} sortDirection="asc" onHeaderClick={noop}
      emptyStateTitle="No curve observations." /> : null}
  </Box>;
}
