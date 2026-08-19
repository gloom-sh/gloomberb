import { Box, Text, TextAttributes, useUiHost } from "../../../ui";
import { StaticChartSurface } from "../../../components";
import { colors, blendHex } from "../../../theme/colors";
import { resolveChartPalette } from "../../../components/chart/core/renderer";
import type { ChartIndicatorOverlays } from "../../../components/chart/core/types";
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

function SentimentBadge({ rating }: { rating: FearGreedRating }) {
  const color = ratingColor(rating);
  return (
    <Box height={1} paddingX={1} backgroundColor={blendHex(colors.bg, color, 0.28)}>
      <Text fg={color} attributes={TextAttributes.BOLD}>{ratingLabel(rating)}</Text>
    </Box>
  );
}

export function PreviousScoreGrid({ data, width, layout = "grid" }: { data: FearGreedData; width: number; layout?: "grid" | "rail" }) {
  const items = [
    { label: "Previous close", value: data.overall.previousClose },
    { label: "1 week ago", value: data.overall.previousWeek },
    { label: "1 month ago", value: data.overall.previousMonth },
    { label: "1 year ago", value: data.overall.previousYear },
  ];
  const columns = width >= 84 ? 4 : width >= 42 ? 2 : 1;
  const columnWidth = Math.max(18, Math.floor((width - 2) / columns));
  const rows = Array.from({ length: Math.ceil(items.length / columns) }, (_, rowIndex) => (
    items.slice(rowIndex * columns, rowIndex * columns + columns)
  ));

  if (layout === "rail") {
    return (
      <Box flexDirection="column" width={width} flexShrink={0}>
        {items.map((item) => {
          const value = item.value;
          const color = value == null ? colors.textDim : ratingColor(value < 25 ? "extreme fear" : value < 45 ? "fear" : value <= 55 ? "neutral" : "greed");
          return (
            <Box key={item.label} flexDirection="row" height={1}>
              <Text fg={colors.textDim}>{item.label}: </Text>
              <Box flexGrow={1} />
              <Text fg={color} attributes={TextAttributes.BOLD}>{formatScore(value)}</Text>
            </Box>
          );
        })}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      {rows.map((row, rowIndex) => (
        <Box key={rowIndex} flexDirection="row" height={1}>
          {row.map((item) => {
            const value = item.value;
            const color = value == null ? colors.textDim : ratingColor(value < 25 ? "extreme fear" : value < 45 ? "fear" : value <= 55 ? "neutral" : "greed");
            return (
              <Box key={item.label} width={columnWidth} flexShrink={0} flexDirection="row">
                <Text fg={colors.textDim}>{item.label}: </Text>
                <Text fg={color} attributes={TextAttributes.BOLD}>{formatScore(value)}</Text>
              </Box>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}

function chartOverlay(indicator: FearGreedIndicator): ChartIndicatorOverlays | null {
  if (indicator.secondaryPoints.length === 0) return null;
  return {
    smaLines: [{
      period: 0,
      points: indicator.secondaryPoints,
      color: colors.warning,
    }],
    emaLines: [],
    bollinger: null,
    rsi: null,
    macd: null,
  };
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
  overlays?: ChartIndicatorOverlays | null;
}) {
  const isDesktopWeb = useUiHost().kind === "desktop-web";
  const stackMeta = width < CHART_META_STACK_WIDTH;
  const chartWidth = Math.max(24, width - 2);
  const chartHeight = width >= 96 ? 12 : 10;
  const color = ratingColor(rating);
  const basePalette = resolveChartPalette(colors, ratingTrend(rating));
  const palette = {
    ...basePalette,
    lineColor: color,
    fillColor: blendHex(colors.bg, color, 0.18),
    gridColor: blendHex(colors.bg, colors.border, 0.55),
  };
  const latest = points.length > 0 ? points[points.length - 1]!.close : null;

  return (
    <Box flexDirection="column" marginTop={isDesktopWeb ? 1 : 2} paddingX={1}>
      <Box flexDirection="row" height={1}>
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{title.toUpperCase()}</Text>
        <Box flexGrow={1} />
        <SentimentBadge rating={rating} />
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
      {points.length >= 2 ? (
        <Box marginTop={1}>
          <StaticChartSurface
            points={points}
            width={chartWidth}
            height={chartHeight}
            mode="line"
            colors={palette}
            indicators={overlays}
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
    </Box>
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
  // The index history charts the score itself, so its "latest" repeats the score.
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

export function IndexHistoryChart({ data, width }: { data: FearGreedData; width: number }) {
  const indicator: FearGreedIndicator = {
    definition: {
      id: "index-history",
      title: "Index History",
      subtitle: "Fear & Greed score over the past year",
      primaryKey: "fear_and_greed_historical",
      primaryLabel: "Fear & Greed",
      valueFormat: "score",
    },
    score: data.overall.score,
    rating: data.overall.rating,
    updatedAt: data.overall.updatedAt,
    points: data.overall.history,
    secondaryPoints: [],
    latestValue: data.overall.score,
    latestSecondaryValue: null,
  };

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
    />
  );
}

export function IndicatorChart({ indicator, width }: { indicator: FearGreedIndicator; width: number }) {
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
      overlays={chartOverlay(indicator)}
    />
  );
}
