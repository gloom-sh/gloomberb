import { useMemo, useState } from "react";
import { CompositeChart } from "../../../components/chart/composite";
import { ExternalLinkText } from "../../../components/ui";
import { blendHex, colors } from "../../../theme/colors";
import type { ResolvedSeries } from "../../../time-series/types";
import { Box, Text } from "../../../ui";
import { formatNumber } from "../../../utils/format";
import { categoryLabel, type StatDef } from "./defs";
import type { StatPoint } from "./transform";
import type { StatViewModel } from "./view";

const AXIS_WIDTH = 8;
const PANELS = [{ id: "main" }];

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
  const chartWidth = Math.max(24, width - 2);
  const chartHeight = Math.max(8, Math.min(26, height - 14));
  const visible = view.visible;

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
    <Box flexDirection="column" width={width} paddingX={1} gap={1}>
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

      <Box flexDirection="column" gap={0}>
        <Box flexDirection="row" height={1} overflow="hidden">
          <Text fg={colors.textDim}>1Y ago </Text>
          <Text fg={colors.text}>
            {view.yearAgo ? stat.formatValue(view.yearAgo.value) : "--"}
          </Text>
          <Text fg={colors.textDim}>{"  mean "}</Text>
          <Text fg={colors.text}>{stat.formatValue(view.mean)}</Text>
          <Text fg={colors.textDim}>{"  %ile "}</Text>
          <Text fg={colors.textBright}>{formatNumber(view.percentile, 0)}</Text>
        </Box>
        <Box flexDirection="row" height={1} overflow="hidden">
          <Text fg={colors.textDim}>High </Text>
          <Text fg={colors.text}>{`${stat.formatValue(view.high.value)} ${view.high.date}`}</Text>
          <Text fg={colors.textDim}>{"  Low "}</Text>
          <Text fg={colors.text}>{`${stat.formatValue(view.low.value)} ${view.low.date}`}</Text>
        </Box>
        <Box flexDirection="row" height={1} overflow="hidden">
          <Text fg={colors.textDim}>{`${categoryLabel(stat.category)} · FRED ${stat.seriesId}`}</Text>
        </Box>
      </Box>

      <Box flexDirection="column" gap={1} width={Math.max(1, width - 2)}>
        <Text fg={colors.textDim} wrapMode="word" wrapText>{stat.note}</Text>
        <Box flexDirection="row" height={1} overflow="hidden">
          <ExternalLinkText
            url={`https://fred.stlouisfed.org/series/${stat.seriesId}`}
            label={`${stat.label}, FRED`}
            color={colors.text}
          />
        </Box>
      </Box>
    </Box>
  );
}
