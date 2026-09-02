import { StaticChartSurface } from "../../../components";
import { resolveChartPalette } from "../../../components/chart/core/renderer";
import { ExternalLinkText } from "../../../components/ui";
import { blendHex, colors } from "../../../theme/colors";
import { Box, Text, TextAttributes } from "../../../ui";
import { formatNumber } from "../../../utils/format";
import type { IndicatorViewModel } from "./view";
import { ZoneColorScale } from "./zone-scale";

/** Matches StaticChartSurface's right Y-axis gutter so the zone scale lines up with the plot. */
function chartPlotInset(view: IndicatorViewModel): number {
  const format = view.indicator.formatValue;
  const labelWidth = Math.max(
    format(view.chart.yDomain.min).length,
    format(view.chart.yDomain.max).length,
    5,
  );
  return Math.min(labelWidth, 12) + 1;
}

/** Row of the plot a value lands on, so its caption can sit just above the line. */
function plotRow(
  value: number,
  yDomain: { min: number; max: number },
  chartHeight: number,
  hasXAxis: boolean,
): number {
  const plotHeight = Math.max(1, chartHeight - (hasXAxis ? 1 : 0));
  const range = yDomain.max - yDomain.min || 1;
  return Math.max(
    0,
    Math.min(
      plotHeight - 1,
      Math.round((1 - (value - yDomain.min) / range) * Math.max(plotHeight - 1, 0)),
    ),
  );
}

function formatTrillions(billions: number): string {
  return `${formatNumber(billions / 1000, 1)}T`;
}

export function IndicatorDetail({
  view,
  width,
  height,
}: {
  view: IndicatorViewModel;
  width: number;
  height: number;
}) {
  const indicator = view.indicator;
  const chartWidth = Math.max(24, width - 2);
  const chartHeight = Math.max(7, Math.min(width >= 96 ? 14 : 12, height - 9));
  const plotInset = chartPlotInset(view);
  const plotWidth = Math.max(1, chartWidth - plotInset);
  const hasXAxis = view.chart.yearLabels.length > 0;

  const palette = {
    ...resolveChartPalette(colors, "neutral"),
    gridColor: blendHex(colors.bg, colors.border, 0.55),
  };

  // Captions for the reference and mean lines, dropped when they would collide.
  const captions = view.chart.markers
    .map((marker) => ({
      ...marker,
      row: plotRow(marker.value, view.chart.yDomain, chartHeight, hasXAxis),
    }))
    .sort((a, b) => a.row - b.row)
    .filter((marker, index, all) => index === 0 || marker.row - all[index - 1]!.row >= 2);

  return (
    <Box flexDirection="column" width={width} paddingX={1} gap={1}>
      {view.chart.points.length >= 2 ? (
        <Box flexDirection="column" gap={0}>
          <Box flexDirection="row" width={chartWidth} overflow="hidden">
            <ZoneColorScale
              indicator={indicator}
              value={view.current.ratio}
              width={plotWidth}
              markerColor={view.zone.color}
            />
            <Text>{" ".repeat(plotInset)}</Text>
          </Box>
          <Box position="relative" width={chartWidth} height={chartHeight}>
            <StaticChartSurface
              points={view.chart.points}
              width={chartWidth}
              height={chartHeight}
              mode="line"
              colors={palette}
              indicators={view.chart.overlays}
              yDomain={view.chart.yDomain}
              lineColors={view.chart.lineColors}
              xAxisLabels={view.chart.yearLabels}
              xAxisColor={colors.textDim}
              yAxisColor={colors.textDim}
              formatYAxisValue={(value) => indicator.formatValue(value)}
            />
            {captions.map((marker) => (
              <Box
                key={marker.label}
                position="absolute"
                left={0}
                top={Math.max(0, marker.row - 1)}
                height={1}
                overflow="hidden"
              >
                <Text fg={colors.textMuted} attributes={TextAttributes.ITALIC | TextAttributes.DIM}>
                  {marker.label}
                </Text>
              </Box>
            ))}
          </Box>
        </Box>
      ) : (
        <Box height={chartHeight} justifyContent="center" alignItems="center">
          <Text fg={colors.textMuted}>Not enough chart data</Text>
        </Box>
      )}

      <Box flexDirection="column" gap={0}>
        <Box flexDirection="row" height={1} overflow="hidden">
          <Text fg={colors.textDim}>{`${indicator.numeratorLabel} `}</Text>
          <Text fg={colors.textBright}>{formatTrillions(view.current.numeratorBillions)}</Text>
          <Text fg={colors.textDim}>{`  ${indicator.denominatorLabel} `}</Text>
          <Text fg={colors.textBright}>{formatTrillions(view.current.denominatorBillions)}</Text>
          <Text fg={colors.textDim}>{`  ${view.denominatorVintageLabel}`}</Text>
        </Box>
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
