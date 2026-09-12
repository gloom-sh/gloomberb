import { useMemo, useState } from "react";
import { CompositeChart } from "../../../components/chart/composite";
import { ExternalLinkText } from "../../../components/ui";
import { blendHex, colors } from "../../../theme/colors";
import { Box, Text } from "../../../ui";
import { formatNumber } from "../../../utils/format";
import { markerSeries, zoneSeriesFor } from "./chart-projection";
import type { IndicatorViewModel } from "./view";
import { ZoneColorScale } from "./zone-scale";

function formatTrillions(billions: number): string {
  return `${formatNumber(billions / 1000, 1)}T`;
}

export function IndicatorDetail({
  view,
  width,
  height,
  focused = false,
}: {
  view: IndicatorViewModel;
  width: number;
  height: number;
  focused?: boolean;
}) {
  const PANELS = [{ id: "main" }];
  const indicator = view.indicator;
  const levels = indicator.input.kind === "ratio" ? indicator.input.levels : undefined;
  const [userViewport, setUserViewport] = useState<{ start: Date; end: Date } | null>(null);
  const chartWidth = Math.max(24, width - 2);
  const AXIS_WIDTH = 8;
  // Give a tall pane a taller plot instead of leaving the space empty below.
  const chartHeight = Math.max(8, Math.min(26, height - 16));

  const visible = view.chart.sourcePoints;
  const series = useMemo(() => {
    const zones = zoneSeriesFor(indicator, visible);
    const markers = [
      indicator.reference
        ? markerSeries(
          indicator,
          "reference",
          indicator.reference.label,
          indicator.reference.value,
          colors.textDim,
          visible,
        )
        : null,
      markerSeries(
        indicator,
        "mean",
        "mean",
        view.mean,
        blendHex(colors.textDim, colors.bg, 0.35),
        visible,
      ),
    ].filter((entry) => entry != null);
    return [...markers, ...zones];
  }, [indicator, view.mean, visible]);

  // One clean entry instead of a row per valuation band.
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
      {view.chart.points.length >= 2 ? (
        <Box flexDirection="column" gap={0}>
          <Box flexDirection="row" width={chartWidth} overflow="hidden">
            <Text>{" ".repeat(AXIS_WIDTH)}</Text>
            <ZoneColorScale
              indicator={indicator}
              value={view.current.ratio}
              width={Math.max(1, chartWidth - AXIS_WIDTH)}
              markerColor={view.zone.color}
            />
          </Box>
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
            viewportResetKey={`${indicator.id}:${view.range}`}
            onViewportChange={setUserViewport}
            formatValue={(value) => indicator.formatValue(value)}
            emptyMessage="Not enough chart data"
          />
        </Box>
      ) : (
        <Box height={chartHeight} justifyContent="center" alignItems="center">
          <Text fg={colors.textMuted}>Not enough chart data</Text>
        </Box>
      )}

      <Text fg={colors.textDim} wrapMode="word" wrapText>{indicator.description}</Text>

      <Box flexDirection="column" gap={0} width={Math.max(1, width - 2)}>
        {levels && view.current.numeratorBillions != null
          && view.current.denominatorBillions != null ? (
          <Box flexDirection="row" flexWrap="wrap" columnGap={2} rowGap={0}>
            <Box flexDirection="row" flexShrink={0}>
              <Text fg={colors.textDim}>{`${levels.numeratorLabel} `}</Text>
              <Text fg={colors.textBright}>{formatTrillions(view.current.numeratorBillions)}</Text>
            </Box>
            <Box flexDirection="row" flexShrink={0}>
              <Text fg={colors.textDim}>{`${levels.denominatorLabel} `}</Text>
              <Text fg={colors.textBright}>{formatTrillions(view.current.denominatorBillions)}</Text>
            </Box>
            {view.vintageLabel ? <Text fg={colors.textDim}>{view.vintageLabel}</Text> : null}
          </Box>
        ) : null}
        <Box flexDirection="row" flexWrap="wrap" columnGap={2} rowGap={0}>
          {[
            ["1Y ago", view.ratioOneYearAgo == null ? "--" : indicator.formatValue(view.ratioOneYearAgo)],
            ["mean", indicator.formatValue(view.mean)],
            ["ATH", `${indicator.formatValue(view.allTimeHigh.ratio)} ${view.allTimeHigh.date}`],
            ["ATL", `${indicator.formatValue(view.allTimeLow.ratio)} ${view.allTimeLow.date}`],
          ].map(([label, value]) => (
            <Box key={label} flexDirection="row" flexShrink={0}>
              <Text fg={colors.textDim}>{`${label} `}</Text>
              <Text fg={colors.text}>{value}</Text>
            </Box>
          ))}
        </Box>
      </Box>

      {indicator.link ? (
        <ExternalLinkText url={indicator.link.url} label={indicator.link.label} color={colors.text} />
      ) : null}
    </Box>
  );
}
