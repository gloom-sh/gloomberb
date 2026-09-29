import { useMemo } from "react";
import { Badge, resolveChartPalette, StaticChartSurface, type StaticChartOverlay } from "../../../components";
import { blendHex, colors } from "../../../theme/colors";
import { Box, Text, TextAttributes, useUiHost } from "../../../ui";
import type {
  FearGreedData,
  FearGreedIndicator,
  FearGreedRating,
  FearGreedValueFormat,
} from "./data";
import {
  formatAxisValue,
  formatIndicatorValue,
  formatScore,
  formatUpdatedAt,
  ratingColor,
  ratingLabel,
  ratingTrend,
} from "./format";

const CHART_META_STACK_WIDTH = 84;

function chartOverlay(indicator: FearGreedIndicator): StaticChartOverlay[] | undefined {
  if (indicator.secondaryPoints.length === 0) return undefined;
  return [{ id: "secondary", color: colors.warning, points: indicator.secondaryPoints }];
}

function SentimentChart({
  title,
  rating,
  score,
  points,
  width,
  valueFormat,
  updatedAt,
  primaryLabel,
  secondaryLabel,
  secondaryValue,
  overlays,
}: {
  title: string;
  rating: FearGreedRating;
  score: number | null;
  points: FearGreedIndicator["points"];
  width: number;
  valueFormat: FearGreedValueFormat;
  updatedAt: Date | null;
  primaryLabel: string;
  secondaryLabel?: string;
  secondaryValue?: number | null;
  overlays?: StaticChartOverlay[];
}) {
  const isDesktopWeb = useUiHost().kind === "desktop-web";
  const stackMeta = width < CHART_META_STACK_WIDTH;
  const color = ratingColor(rating);
  const latest = points.length > 0 ? points[points.length - 1]!.close : null;

  return (
    <Box flexDirection="column" marginTop={isDesktopWeb ? 1 : 2} paddingX={1}>
      <Box flexDirection="row" height={1}>
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{title.toUpperCase()}</Text>
        <Box flexGrow={1} />
        <Badge label={ratingLabel(rating)} color={ratingColor(rating)} />
      </Box>
      {stackMeta ? (
        <>
          <Box flexDirection="row" height={1} overflow="hidden">
            <SeriesLegend color={color} primaryLabel={primaryLabel} secondaryLabel={secondaryLabel} />
          </Box>
          <Box flexDirection="row" height={1} overflow="hidden">
            <ChartStats
              color={color}
              latest={latest}
              score={score}
              secondaryLabel={secondaryLabel}
              secondaryValue={secondaryValue}
              valueFormat={valueFormat}
            />
          </Box>
        </>
      ) : (
        <Box flexDirection="row" height={1} overflow="hidden">
          <SeriesLegend color={color} primaryLabel={primaryLabel} secondaryLabel={secondaryLabel} />
          <Box flexGrow={1} />
          <ChartStats
            color={color}
            latest={latest}
            score={score}
            secondaryLabel={secondaryLabel}
            secondaryValue={secondaryValue}
            valueFormat={valueFormat}
          />
        </Box>
      )}
      <SentimentPlot
        rating={rating}
        points={points}
        width={width}
        valueFormat={valueFormat}
        updatedAt={updatedAt}
        overlays={overlays}
      />
    </Box>
  );
}

function SentimentPlot({
  rating,
  points,
  width,
  valueFormat,
  updatedAt,
  overlays,
}: {
  rating: FearGreedRating;
  points: FearGreedIndicator["points"];
  width: number;
  valueFormat: FearGreedValueFormat;
  updatedAt: Date | null;
  overlays?: StaticChartOverlay[];
}) {
  const chartWidth = Math.max(24, width - 2);
  const chartHeight = width >= 96 ? 12 : 10;
  const color = ratingColor(rating);
  const palette = useMemo(() => {
    const basePalette = resolveChartPalette(colors, ratingTrend(rating));
    return {
      ...basePalette,
      lineColor: color,
      fillColor: blendHex(colors.bg, color, 0.18),
      gridColor: blendHex(colors.bg, colors.border, 0.55),
    };
  }, [color, rating]);

  return (
    <>
      {points.length >= 2 ? (
        <Box marginTop={1}>
          <StaticChartSurface
            points={points}
            width={chartWidth}
            height={chartHeight}
            mode="line"
            colors={palette}
            overlays={overlays}
            showTimeAxis
            timeAxisColor={colors.textDim}
            yAxisColor={colors.textDim}
            formatYAxisValue={formatAxisValue(valueFormat)}
          />
        </Box>
      ) : (
        <Box height={chartHeight} marginTop={1} justifyContent="center" alignItems="center">
          <Text fg={colors.textMuted}>Not enough chart data</Text>
        </Box>
      )}
      <Box height={1} marginTop={1}>
        <Text fg={colors.textDim}>{formatUpdatedAt(updatedAt)}</Text>
      </Box>
    </>
  );
}

function SeriesLegend({
  color,
  primaryLabel,
  secondaryLabel,
}: {
  color: string;
  primaryLabel: string;
  secondaryLabel?: string;
}) {
  return (
    <>
      <Text fg={color}>● </Text>
      <Text fg={colors.textDim}>{primaryLabel}</Text>
      {secondaryLabel ? (
        <>
          <Text fg={colors.warning}>  ● </Text>
          <Text fg={colors.textDim}>{secondaryLabel}</Text>
        </>
      ) : null}
    </>
  );
}

function ChartStats({
  color,
  latest,
  score,
  secondaryLabel,
  secondaryValue,
  valueFormat,
}: {
  color: string;
  latest: number | null;
  score: number | null;
  secondaryLabel?: string;
  secondaryValue?: number | null;
  valueFormat: FearGreedValueFormat;
}) {
  // Hide a latest value that reads the same as the score.
  const latestText = formatIndicatorValue(latest, valueFormat);
  const showLatest = latestText !== formatScore(score);
  return (
    <>
      <Text fg={colors.textDim}>score </Text>
      <Text fg={color} attributes={TextAttributes.BOLD}>{formatScore(score)}</Text>
      {showLatest ? (
        <>
          <Text fg={colors.textDim}>  latest </Text>
          <Text fg={colors.text}>{latestText}</Text>
        </>
      ) : null}
      {secondaryLabel && secondaryValue != null ? (
        <>
          <Text fg={colors.textDim}>  avg </Text>
          <Text fg={colors.text}>{formatIndicatorValue(secondaryValue, valueFormat)}</Text>
        </>
      ) : null}
    </>
  );
}

// The gauge above already shows the score, its rating and what the series is,
// so the history is the plot alone.
export function IndexHistoryChart({ data, width }: { data: FearGreedData; width: number }) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <SentimentPlot
        rating={data.overall.rating}
        points={data.overall.history}
        width={width}
        valueFormat="score"
        updatedAt={data.overall.updatedAt}
      />
    </Box>
  );
}

export function IndicatorChart({ indicator, width }: { indicator: FearGreedIndicator; width: number }) {
  const overlays = useMemo(() => chartOverlay(indicator), [indicator.secondaryPoints]);
  return (
    <SentimentChart
      title={indicator.definition.title}
      rating={indicator.rating}
      score={indicator.score}
      points={indicator.points}
      width={width}
      valueFormat={indicator.definition.valueFormat}
      updatedAt={indicator.updatedAt}
      primaryLabel={indicator.definition.primaryLabel}
      secondaryLabel={indicator.definition.secondaryLabel}
      secondaryValue={indicator.latestSecondaryValue}
      overlays={overlays}
    />
  );
}
