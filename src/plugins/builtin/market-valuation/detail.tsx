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

      <Box flexDirection="column" gap={0}>
        {levels && view.current.numeratorBillions != null
          && view.current.denominatorBillions != null ? (
          <Box flexDirection="row" height={1} overflow="hidden">
            <Text fg={colors.textDim}>{`${levels.numeratorLabel} `}</Text>
            <Text fg={colors.textBright}>{formatTrillions(view.current.numeratorBillions)}</Text>
            <Text fg={colors.textDim}>{`  ${levels.denominatorLabel} `}</Text>
            <Text fg={colors.textBright}>{formatTrillions(view.current.denominatorBillions)}</Text>
            {view.vintageLabel ? (
              <Text fg={colors.textDim}>{`  ${view.vintageLabel}`}</Text>
            ) : null}
          </Box>
        ) : null}
        <Box flexDirection="row" height={1} overflow="hidden">
          <Text fg={colors.textDim}>1Y ago </Text>
          <Text fg={colors.text}>
            {view.ratioOneYearAgo == null ? "--" : indicator.formatValue(view.ratioOneYearAgo)}
          </Text>
          <Text fg={colors.textDim}>{"  mean "}</Text>
          <Text fg={colors.text}>{indicator.formatValue(view.mean)}</Text>
          <Text fg={colors.textDim}>{"  ATH "}</Text>
          <Text fg={colors.text}>
            {`${indicator.formatValue(view.allTimeHigh.ratio)} ${view.allTimeHigh.date}`}
          </Text>
          <Text fg={colors.textDim}>{"  ATL "}</Text>
          <Text fg={colors.text}>
            {`${indicator.formatValue(view.allTimeLow.ratio)} ${view.allTimeLow.date}`}
          </Text>
        </Box>
      </Box>

      <Box flexDirection="column" gap={1} width={Math.max(1, width - 2)}>
        {indicator.notes.map((note) => (
          <Text key={note.slice(0, 24)} fg={colors.textDim} wrapMode="word" wrapText>
            {note}
          </Text>
        ))}
        {indicator.link ? (
          <Box flexDirection="row" height={1} overflow="hidden">
            <ExternalLinkText
              url={indicator.link.url}
              label={indicator.link.label}
              color={colors.text}
            />
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
