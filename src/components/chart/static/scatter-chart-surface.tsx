import { useMemo } from "react";
import { Box, Text } from "../../../ui";
import { colors } from "../../../theme/colors";
import type { ResolvedSeries } from "../../../time-series/types";
import { CompositeChart } from "../composite/composite-chart";
import type { CompositeChartXMarker } from "../composite/types";
import { scalarPoint, staticSeries } from "./series";
import { trailAxisTicks } from "./trail-chart-model";

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
  /** What x measures: named at the end of the x axis, after its values. */
  xLabel?: string;
  /** What y measures: named above the y axis, whose values stand beside the plot. */
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
  /** The x values the plot spans, which its axis labels read against. */
  xMin: number;
  xMax: number;
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
  return { series, markers, xMin, xMax };
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
  const titleRows = yLabel ? 1 : 0;
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
  // x is not time here: the axis row carries round x values and, last, the
  // axis's name, which wins over a value that would run into it.
  const xAxis = useMemo(() => model ? {
    markers: model.markers,
    ticks: [
      ...trailAxisTicks(model.xMin, model.xMax),
      ...(xLabel ? [{ label: `${xLabel} →`, ratio: 1 }] : []),
    ],
  } : undefined, [model, xLabel]);

  if (!model) {
    return (
      <Box width={totalWidth} height={totalHeight}>
        <Text fg={colors.textDim}>No scatter data</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={totalWidth} height={totalHeight}>
      {yLabel ? (
        // Over the y axis's values at the right edge, which the arrow points up from.
        <Box flexDirection="row" height={1} flexShrink={0} paddingRight={1} justifyContent="flex-end">
          <Text fg={chartColors.axisColor}>{`${yLabel} ↑`}</Text>
        </Box>
      ) : null}
      <CompositeChart
        series={model.series}
        panels={PANELS}
        width={totalWidth}
        height={Math.max(3, totalHeight - titleRows)}
        colors={compositeColors}
        interactive={false}
        navigable={false}
        showLegend={false}
        showTimeAxis
        xAxis={xAxis}
      />
    </Box>
  );
}
