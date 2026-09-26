import { useMemo } from "react";
import { ExternalLinkText, type StatItem } from "../../../components/ui";
import { fredSeriesUrl } from "../../../data/fred-series";
import { colors } from "../../../theme/colors";
import { Box, Text } from "../../../ui";
import { scalarLine, SeriesDetailChart, type SeriesAxis } from "../shared/series-detail-chart";
import type { StatDef } from "./defs";
import type { StatViewModel } from "./view";

const SOURCE_ROWS = 1;

function statAxis(stat: StatDef): SeriesAxis {
  return {
    unit: stat.axisUnit,
    unitGroup: stat.axisUnit === "%" ? "economic-percent" : "economic",
    nativeFrequency: "monthly",
  };
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
  const visible = view.visible;
  const stats = useMemo<StatItem[]>(() => [
    { id: "year-ago", label: "1Y ago", value: view.yearAgo ? stat.formatValue(view.yearAgo.value) : "--" },
    { id: "high", label: "High", value: stat.formatValue(view.high.value), detail: view.high.date },
    { id: "low", label: "Low", value: stat.formatValue(view.low.value), detail: view.low.date },
  ], [stat, view.high, view.low, view.yearAgo]);
  const lines = useMemo(
    () => [scalarLine(statAxis(stat), stat.id, stat.shortLabel, colors.textBright, visible)],
    [stat, visible],
  );

  return (
    <SeriesDetailChart
      stats={stats}
      width={width}
      height={height}
      focused={focused}
      points={visible}
      lines={lines}
      axis={statAxis(stat)}
      mean={view.mean}
      reference={stat.reference}
      resetKey={`${stat.id}:${view.range}`}
      formatValue={stat.formatValue}
      // The source line under the chart; the chart takes every other row.
      belowChartRows={SOURCE_ROWS}
      belowChart={(
        <Box flexDirection="row" flexWrap="wrap" paddingX={1} flexShrink={0}>
          <ExternalLinkText
            url={fredSeriesUrl(stat.seriesId)}
            label={`FRED ${stat.seriesId}`}
            color={colors.text}
          />
          {stat.measurementBasis ? <Text fg={colors.textDim}>{` · ${stat.measurementBasis}`}</Text> : null}
        </Box>
      )}
    />
  );
}
