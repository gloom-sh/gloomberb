import { useMemo } from "react";
import { Box, Text } from "../../../ui";
import type { ResolvedSeries } from "../../../time-series/types";
import { CompositeChart } from "../composite/composite-chart";
import type { CompositeChartXAxis, CompositeChartXMarker } from "../composite/types";
import type { ProjectedChartPoint } from "../core/data";
import type { ChartRenderMode } from "../core/types";
import { scalarPoint, staticSeries } from "./series";

export type StaticChartXMarker = CompositeChartXMarker;

/** A second line drawn over the primary points, aligned by observation index. */
export interface StaticChartOverlay {
  id: string;
  color: string;
  points: ReadonlyArray<{ index: number; value: number }>;
}

/** The subset of `ResolvedChartPalette` a static chart reads. */
interface StaticChartPalette {
  lineColor: string;
  gridColor: string;
  crosshairColor: string;
  bgColor: string;
  axisColor: string;
  candleDown?: string;
}

export interface StaticChartSurfaceProps {
  points: ProjectedChartPoint[];
  width: number;
  height: number;
  mode?: ChartRenderMode;
  colors: StaticChartPalette;
  overlays?: readonly StaticChartOverlay[];
  showTimeAxis?: boolean;
  timeAxisColor?: string;
  /** Evenly spread labels for an x that is not time; implies an axis row. */
  xAxisLabels?: readonly string[];
  xAxisColor?: string;
  formatXAxisCursorValue?: (xRatio: number) => string;
  xMarkers?: readonly StaticChartXMarker[];
  yAxisLabel?: string;
  yAxisColor?: string;
  formatYAxisValue?: (value: number) => string;
}

const STYLE_BY_MODE: Record<ChartRenderMode, ResolvedSeries["style"]> = {
  area: "area",
  line: "line",
  candles: "candles",
  ohlc: "ohlc",
  hlc: "hlc",
};

const PANELS = [{ id: "main" }];

export function buildStaticChartSeries(
  points: readonly ProjectedChartPoint[],
  mode: ChartRenderMode,
  color: string,
  overlays: readonly StaticChartOverlay[] = [],
): ResolvedSeries[] {
  const ohlc = mode === "candles" || mode === "ohlc" || mode === "hlc";
  const primary = staticSeries(
    points.map((point) => ({
      date: point.date,
      observedAt: point.date,
      value: point.close,
      ...(ohlc
        ? { open: point.open, high: point.high, low: point.low, close: point.close, volume: point.volume }
        : {}),
    })),
    { id: "primary", color, style: STYLE_BY_MODE[mode], dataShape: ohlc ? "ohlcv" : "scalar" },
  );
  const overlaySeries = overlays.map((overlay) => staticSeries(
    overlay.points.flatMap(({ index, value }) => {
      const anchor = points[index];
      return anchor && Number.isFinite(value) ? [scalarPoint(anchor.date, value)] : [];
    }),
    { id: overlay.id, color: overlay.color },
  ));
  return [primary, ...overlaySeries];
}

export function StaticChartSurface({
  points,
  width,
  height,
  mode = "line",
  colors,
  overlays,
  showTimeAxis = false,
  timeAxisColor,
  xAxisLabels,
  xAxisColor,
  formatXAxisCursorValue,
  xMarkers,
  yAxisLabel,
  yAxisColor,
  formatYAxisValue,
}: StaticChartSurfaceProps) {
  const totalWidth = Math.max(1, Math.floor(width));
  const totalHeight = Math.max(1, Math.floor(height));
  const labelRows = yAxisLabel ? 1 : 0;
  const series = useMemo(
    () => buildStaticChartSeries(points, mode, colors.lineColor, overlays),
    [colors.lineColor, mode, overlays, points],
  );
  const chartColors = useMemo(() => ({
    background: colors.bgColor,
    grid: colors.gridColor,
    crosshair: colors.crosshairColor,
    text: colors.axisColor,
    textDim: yAxisColor ?? xAxisColor ?? timeAxisColor ?? colors.axisColor,
    negative: colors.candleDown ?? colors.lineColor,
  }), [colors, timeAxisColor, xAxisColor, yAxisColor]);
  const formatAxisValue = useMemo(
    () => formatYAxisValue ? (value: number) => formatYAxisValue(value) : undefined,
    [formatYAxisValue],
  );
  const xAxis = useMemo<CompositeChartXAxis | undefined>(() => (
    xAxisLabels || xMarkers || formatXAxisCursorValue
      ? { labels: xAxisLabels, markers: xMarkers, formatCursor: formatXAxisCursorValue }
      : undefined
  ), [formatXAxisCursorValue, xAxisLabels, xMarkers]);

  return (
    <Box flexDirection="column" width={totalWidth} height={totalHeight}>
      {yAxisLabel ? (
        <Box height={1}>
          <Text fg={yAxisColor}>{yAxisLabel}</Text>
        </Box>
      ) : null}
      <CompositeChart
        series={series}
        panels={PANELS}
        width={totalWidth}
        height={Math.max(1, totalHeight - labelRows)}
        colors={chartColors}
        navigable={false}
        showLegend={false}
        showTimeAxis={showTimeAxis || (xAxisLabels?.length ?? 0) > 0}
        formatAxisValue={formatAxisValue}
        xAxis={xAxis}
        remoteKind="static-chart"
      />
    </Box>
  );
}
