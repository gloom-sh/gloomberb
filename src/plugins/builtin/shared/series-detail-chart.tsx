import { useMemo, useState, type ReactNode } from "react";
import { CompositeChart } from "../../../components/chart/composite";
import { StatGrid, statGridRows, type StatItem } from "../../../components/ui";
import { blendHex, colors } from "../../../theme/colors";
import type { ResolvedSeries, SeriesPeriod } from "../../../time-series/types";
import { Box, Text } from "../../../ui";

const PANELS = [{ id: "main" }];
const AXIS_WIDTH = 8;
const MIN_CHART_ROWS = 8;

/** Where a line sits: the mean and reference lines share it with the data. */
export interface SeriesAxis {
  unit: string;
  unitGroup: string;
  nativeFrequency: SeriesPeriod;
}

/** One dated line on the detail chart's single panel. */
export function scalarLine(
  axis: SeriesAxis,
  id: string,
  label: string,
  color: string,
  points: readonly { date: string; value: number | null }[],
): ResolvedSeries {
  return {
    id,
    label,
    color,
    unit: axis.unit,
    unitGroup: axis.unitGroup,
    nativeFrequency: axis.nativeFrequency,
    dataShape: "scalar",
    style: "line",
    transform: "raw",
    axis: "left",
    panelId: "main",
    interpolation: "none",
    points: points.map((point) => {
      const date = new Date(point.date);
      return { date, observedAt: date, value: point.value };
    }),
  };
}

/** Flat line at a fixed level, for parity, a target, or the sample mean. */
function flatLine(
  axis: SeriesAxis,
  id: string,
  label: string,
  value: number,
  color: string,
  points: readonly { date: string }[],
): ResolvedSeries | null {
  if (points.length === 0 || !Number.isFinite(value)) return null;
  return scalarLine(axis, id, label, color, [
    { date: points[0]!.date, value },
    { date: points[points.length - 1]!.date, value },
  ]);
}

/**
 * A series detail: its figures, then a chart of the selected range filling the
 * rest of the column, with the mean and an optional reference level drawn flat.
 * Only those two lines get legend entries, so a series drawn in several colour
 * bands still reads as one.
 */
export function SeriesDetailChart({
  stats,
  width,
  height,
  focused,
  points,
  drawable = points.length >= 2,
  lines,
  axis,
  mean,
  reference,
  resetKey,
  formatValue,
  aboveChartRows = 0,
  aboveChart,
  belowChartRows = 0,
  belowChart,
}: {
  stats: StatItem[];
  width: number;
  height: number;
  focused: boolean;
  /** The selected range; it frames the chart and spans the flat lines. */
  points: readonly { date: string }[];
  /** Whether the range has enough usable points to chart. */
  drawable?: boolean;
  lines: readonly ResolvedSeries[];
  axis: SeriesAxis;
  mean: number;
  reference?: { label: string; value: number } | null;
  /** A new key drops the user's zoom and pan. */
  resetKey: string;
  formatValue: (value: number) => string;
  /** Rows kept for `aboveChart`, drawn between the figures and a drawable chart. */
  aboveChartRows?: number;
  aboveChart?: (chartWidth: number) => ReactNode;
  /** Rows kept for `belowChart`, drawn under the chart area. */
  belowChartRows?: number;
  belowChart?: ReactNode;
}) {
  const [userViewport, setUserViewport] = useState<{ start: Date; end: Date } | null>(null);
  const chartWidth = Math.max(24, width);
  const statRows = statGridRows(stats, width);
  const chartHeight = Math.max(MIN_CHART_ROWS, height - statRows - aboveChartRows - belowChartRows);
  const { unit, unitGroup, nativeFrequency } = axis;

  const series = useMemo(() => {
    const lineAxis = { unit, unitGroup, nativeFrequency };
    const markers = [
      reference
        ? flatLine(lineAxis, "reference", reference.label, reference.value, colors.textDim, points)
        : null,
      flatLine(lineAxis, "mean", "mean", mean, blendHex(colors.textDim, colors.bg, 0.35), points),
    ].filter((entry) => entry != null);
    return [...markers, ...lines];
  }, [lines, mean, nativeFrequency, points, reference, unit, unitGroup]);

  const legendSeries = useMemo(
    () => series.filter((entry) => entry.id === "reference" || entry.id === "mean"),
    [series],
  );

  const viewport = useMemo(() => {
    if (userViewport) return userViewport;
    if (points.length < 2) return undefined;
    return { start: new Date(points[0]!.date), end: new Date(points.at(-1)!.date) };
  }, [userViewport, points]);

  return (
    <Box flexDirection="column" width={width}>
      <StatGrid items={stats} width={width} />
      {drawable ? (
        <>
          {aboveChart?.(chartWidth)}
          <CompositeChart
            series={series}
            legendSeries={legendSeries}
            panels={PANELS}
            width={chartWidth}
            height={chartHeight}
            focused={focused}
            interactive
            axisWidth={AXIS_WIDTH}
            showLegend
            viewport={viewport}
            viewportResetKey={resetKey}
            onViewportChange={setUserViewport}
            formatValue={(value) => formatValue(value)}
            emptyMessage="Not enough chart data"
          />
        </>
      ) : (
        <Box height={chartHeight} justifyContent="center" alignItems="center">
          <Text fg={colors.textMuted}>Not enough chart data</Text>
        </Box>
      )}
      {belowChart}
    </Box>
  );
}
