import { useMemo } from "react";
import { Box, Text } from "../../../ui";
import { colors } from "../../../theme/colors";
import type { ResolvedSeries } from "../../../time-series/types";
import { CompositeChart } from "../composite/composite-chart";
import type { CompositeChartXMarker } from "../composite/types";
import { scalarPoint, staticSeries } from "./series";

export interface ScatterChartPoint {
  x: number;
  y: number;
  highlight?: boolean;
}

interface ScatterRegressionLine {
  slope: number;
  intercept: number;
  color: string;
}

interface ScatterChartColors {
  bgColor: string;
  gridColor: string;
  axisColor: string;
  pointColor: string;
  highlightColor: string;
}

export interface StaticScatterChartSurfaceProps {
  points: ScatterChartPoint[];
  width: number;
  height: number;
  colors?: ScatterChartColors;
  regression?: ScatterRegressionLine | null;
  xLabel?: string;
  yLabel?: string;
}

/**
 * The composite scale is time, so x rides in the timestamp. Returns are small
 * decimals and Date truncates to whole milliseconds, so x is scaled up first.
 */
const X_TO_TIME = 1_000_000;

function timeForX(x: number): Date {
  return new Date(Math.round(x * X_TO_TIME));
}

export interface ScatterChartModel {
  series: ResolvedSeries[];
  markers: CompositeChartXMarker[];
}

export function buildScatterChartModel(
  points: readonly ScatterChartPoint[],
  regression: ScatterRegressionLine | null,
  chartColors: ScatterChartColors,
): ScatterChartModel | null {
  const valid = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (valid.length === 0) return null;
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  for (const point of valid) {
    xMin = Math.min(xMin, point.x);
    xMax = Math.max(xMax, point.x);
    yMin = Math.min(yMin, point.y);
    yMax = Math.max(yMax, point.y);
  }
  const plain = valid.filter((point) => !point.highlight);
  const highlighted = valid.filter((point) => point.highlight);
  const series: ResolvedSeries[] = [];
  const markers: CompositeChartXMarker[] = [];

  if (yMin <= 0 && yMax >= 0 && xMin < xMax) {
    series.push(staticSeries(
      [scalarPoint(timeForX(xMin), 0), scalarPoint(timeForX(xMax), 0)],
      { id: "zero-y", color: chartColors.axisColor, calendarSpaced: true },
    ));
  }
  if (xMin <= 0 && xMax >= 0 && xMin < xMax) {
    markers.push({ id: "zero-x", xRatio: (0 - xMin) / (xMax - xMin), color: chartColors.axisColor });
  }
  if (regression && xMin < xMax) {
    // Clip the fitted line to the data's vertical extent so it cannot stretch
    // the axis, then draw whatever segment survives.
    const lineY = (x: number) => regression.slope * x + regression.intercept;
    let left = xMin;
    let right = xMax;
    if (regression.slope !== 0) {
      const xAt = (y: number) => (y - regression.intercept) / regression.slope;
      const bounds = [xAt(yMin), xAt(yMax)].sort((a, b) => a - b);
      left = Math.max(left, bounds[0]!);
      right = Math.min(right, bounds[1]!);
    }
    const ends = [left, right]
      .map((x) => ({ x, y: lineY(x) }))
      .filter((end) => Number.isFinite(end.y) && end.y >= yMin && end.y <= yMax);
    if (left < right && ends.length === 2) {
      series.push(staticSeries(
        ends.map((end) => scalarPoint(timeForX(end.x), end.y)),
        { id: "regression", color: regression.color, calendarSpaced: true },
      ));
    }
  }
  if (plain.length > 0) {
    series.push(staticSeries(
      plain.map((point) => scalarPoint(timeForX(point.x), point.y)),
      { id: "points", color: chartColors.pointColor, style: "points", calendarSpaced: true },
    ));
  }
  if (highlighted.length > 0) {
    series.push(staticSeries(
      highlighted.map((point) => scalarPoint(timeForX(point.x), point.y)),
      { id: "highlight", color: chartColors.highlightColor, style: "points", calendarSpaced: true },
    ));
  }
  return { series, markers };
}

const PANELS = [{ id: "main" }];

export function StaticScatterChartSurface({
  points,
  width,
  height,
  colors: chartColors = {
    bgColor: colors.bg,
    gridColor: colors.border,
    axisColor: colors.textDim,
    pointColor: "#b197fc",
    highlightColor: colors.negative,
  },
  regression = null,
  xLabel,
  yLabel,
}: StaticScatterChartSurfaceProps) {
  const totalWidth = Math.max(1, Math.floor(width));
  const totalHeight = Math.max(4, Math.floor(height));
  const labelRows = (yLabel ? 1 : 0) + (xLabel ? 1 : 0);
  const plotHeight = Math.max(2, totalHeight - labelRows);
  const model = useMemo(
    () => buildScatterChartModel(points, regression, chartColors),
    [chartColors, points, regression],
  );
  const compositeColors = useMemo(() => ({
    background: chartColors.bgColor,
    grid: chartColors.gridColor,
    crosshair: chartColors.axisColor,
    text: chartColors.axisColor,
    textDim: chartColors.axisColor,
    negative: colors.negative,
  }), [chartColors]);
  const xAxis = useMemo(() => model ? { markers: model.markers } : undefined, [model]);

  if (!model) {
    return (
      <Box width={totalWidth} height={totalHeight}>
        <Text fg={colors.textDim}>No scatter data</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={totalWidth} height={totalHeight}>
      {yLabel ? <Text fg={colors.textDim}>{yLabel}</Text> : null}
      <CompositeChart
        series={model.series}
        panels={PANELS}
        width={totalWidth}
        height={plotHeight}
        colors={compositeColors}
        interactive={false}
        navigable={false}
        showLegend={false}
        showTimeAxis={false}
        axisWidth={0}
        xAxis={xAxis}
      />
      {xLabel ? <Text fg={colors.textDim}>{xLabel}</Text> : null}
    </Box>
  );
}
