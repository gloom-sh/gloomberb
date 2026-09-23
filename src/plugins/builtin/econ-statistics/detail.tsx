import { useMemo, useState } from "react";
import { CompositeChart } from "../../../components/chart/composite";
import { ExternalLinkText, StatGrid, statGridRows, type StatItem } from "../../../components/ui";
import { blendHex, colors } from "../../../theme/colors";
import type { ResolvedSeries } from "../../../time-series/types";
import { Box, Text } from "../../../ui";
import type { StatDef } from "./defs";
import type { StatPoint } from "./transform";
import type { StatViewModel } from "./view";

const AXIS_WIDTH = 8;
const PANELS = [{ id: "main" }];
const MIN_CHART_ROWS = 8;
const SOURCE_ROWS = 1;

function seriesFor(
  stat: StatDef,
  id: string,
  label: string,
  color: string,
  points: readonly StatPoint[],
): ResolvedSeries {
  return {
    id,
    label,
    color,
    unit: stat.axisUnit,
    unitGroup: stat.axisUnit === "%" ? "economic-percent" : "economic",
    nativeFrequency: "monthly",
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

function flatSeries(
  stat: StatDef,
  id: string,
  label: string,
  value: number,
  color: string,
  points: readonly StatPoint[],
): ResolvedSeries | null {
  if (points.length === 0 || !Number.isFinite(value)) return null;
  return seriesFor(stat, id, label, color, [
    { date: points[0]!.date, value },
    { date: points[points.length - 1]!.date, value },
  ]);
}

/**
 * The selected statistic: its range figures, the chart filling the column, and
 * the official series it comes from. The mean is in the chart legend and the
 * percentile in the table row, so neither repeats here.
 */
export function StatDetail({
  view,
  width,
  height,
  focused = false,
}: {
  view: StatViewModel;
  width: number;
  height: number;
  focused?: boolean;
}) {
  const stat = view.stat;
  const [userViewport, setUserViewport] = useState<{ start: Date; end: Date } | null>(null);
  const chartWidth = Math.max(24, width);
  const visible = view.visible;
  const stats = useMemo<StatItem[]>(() => [
    { id: "year-ago", label: "1Y ago", value: view.yearAgo ? stat.formatValue(view.yearAgo.value) : "--" },
    { id: "high", label: "High", value: stat.formatValue(view.high.value), detail: view.high.date },
    { id: "low", label: "Low", value: stat.formatValue(view.low.value), detail: view.low.date },
  ], [stat, view.high, view.low, view.yearAgo]);
  const statRows = statGridRows(stats, width);
  // The source line under the chart; the chart takes every other row.
  const chartHeight = Math.max(MIN_CHART_ROWS, height - statRows - SOURCE_ROWS);

  const series = useMemo(() => {
    const markers = [
      stat.reference
        ? flatSeries(stat, "reference", stat.reference.label, stat.reference.value, colors.textDim, visible)
        : null,
      flatSeries(stat, "mean", "mean", view.mean, blendHex(colors.textDim, colors.bg, 0.35), visible),
    ].filter((entry) => entry != null);
    return [...markers, seriesFor(stat, stat.id, stat.shortLabel, colors.textBright, visible)];
  }, [stat, view.mean, visible]);

  const legendSeries = useMemo(
    () => series.filter((entry) => entry.id === "reference" || entry.id === "mean"),
    [series],
  );

  const viewport = useMemo(() => {
    if (userViewport) return userViewport;
    if (visible.length < 2) return undefined;
    return { start: new Date(visible[0]!.date), end: new Date(visible.at(-1)!.date) };
  }, [userViewport, visible]);

  return (
    <Box flexDirection="column" width={width}>
      <StatGrid items={stats} width={width} />
      {visible.length >= 2 ? (
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
          viewportResetKey={`${stat.id}:${view.range}`}
          onViewportChange={setUserViewport}
          formatValue={(value) => stat.formatValue(value)}
          emptyMessage="Not enough chart data"
        />
      ) : (
        <Box height={chartHeight} justifyContent="center" alignItems="center">
          <Text fg={colors.textMuted}>Not enough chart data</Text>
        </Box>
      )}
      <Box flexDirection="row" flexWrap="wrap" paddingX={1} flexShrink={0}>
        <ExternalLinkText
          url={`https://fred.stlouisfed.org/series/${stat.seriesId}`}
          label={`FRED ${stat.seriesId}`}
          color={colors.text}
        />
        {stat.measurementBasis ? <Text fg={colors.textDim}>{` · ${stat.measurementBasis}`}</Text> : null}
      </Box>
    </Box>
  );
}
