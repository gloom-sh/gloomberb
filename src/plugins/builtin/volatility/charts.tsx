import { useMemo } from "react";
import { EmptyState, StaticChartSurface, type StaticChartOverlay } from "../../../components";
import { resolveChartPalette } from "../../../components/chart/core/palette";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, Text } from "../../../ui";
import {
  volatilityCurveChartModel, volatilityHistoryChartModel, volatilityIndexHistoryPoints, volatilityRatioChartModel,
} from "./chart-model";
import type { FredVolatilityHistory, VolatilityBoardRow, VolatilityCurve } from "./model";

interface ChartSize { width: number; height: number }

export function VolatilityCurveChart({ curve, width, height }: ChartSize & { curve: VolatilityCurve }) {
  const colors = useThemeColors();
  const model = useMemo(() => volatilityCurveChartModel(curve.points), [curve.points]);
  const palette = resolveChartPalette(colors);
  const lineColor = curve.termState === "inverted" ? colors.warning : palette.lineColor;
  const observations: StaticChartOverlay[] = [{ id: "Observed close", color: lineColor, style: "points",
    points: model.points.flatMap((point, index) => Number.isFinite(point.close) ? [{ index, value: point.close }] : []),
  }];
  if (!observations[0]!.points.length) return <EmptyState title="VIX curve unavailable." />;
  return <StaticChartSurface points={model.points} overlays={observations} calendarSpaced
    width={width} height={height} colors={{ ...palette, lineColor }}
    yAxisLabel="IV %" yAxisColor={colors.textDim} formatYAxisValue={(value) => value.toFixed(1)}
    xAxisTicks={model.ticks} formatXAxisCursorValue={model.formatCursor} />;
}

export function VolatilityHistoryChart({ fred, width, height }: ChartSize & { fred: FredVolatilityHistory }) {
  const colors = useThemeColors();
  const palette = resolveChartPalette(colors);
  const model = useMemo(() => volatilityHistoryChartModel(fred, colors.borderFocused), [fred, colors.borderFocused]);
  if (!model.points.some((point) => Number.isFinite(point.close)) && !model.overlays.length) {
    return <EmptyState title="VIX history unavailable." />;
  }
  return <Box flexDirection="column" width={width} height={height}>
    <Box height={1} flexDirection="row" gap={3}>
      <Text fg={colors.warning}>VIX 30D</Text><Text fg={colors.borderFocused}>VIX 3M</Text>
      <Text fg={colors.textDim}>IV %</Text>
    </Box>
    <StaticChartSurface points={model.points} overlays={model.overlays} calendarSpaced showTimeAxis
      width={width} height={Math.max(2, height - 1)} colors={{ ...palette, lineColor: colors.warning }}
      formatYAxisValue={(value) => value.toFixed(1)} />
  </Box>;
}

export function VolatilityRatioChart({ fred, width, height }: ChartSize & { fred: FredVolatilityHistory }) {
  const colors = useThemeColors();
  const palette = resolveChartPalette(colors);
  const model = useMemo(() => volatilityRatioChartModel(fred, colors.textDim), [fred, colors.textDim]);
  if (!model.points.some((point) => Number.isFinite(point.close))) return <EmptyState title="Aligned ratio history unavailable." />;
  const lineColor = fred.termState === "inverted" ? colors.warning : palette.lineColor;
  return <Box flexDirection="column" width={width} height={height}>
    <Box height={1} flexDirection="row" gap={3}>
      <Text fg={lineColor}>{`3M/30D ${fred.ratio == null ? "--" : fred.ratio.toFixed(2)}`}</Text>
      <Text fg={colors.textDim}>1.00 flat</Text>
    </Box>
    <StaticChartSurface points={model.points} overlays={model.overlays} calendarSpaced showTimeAxis
      width={width} height={Math.max(2, height - 1)} colors={{ ...palette, lineColor }}
      formatYAxisValue={(value) => value.toFixed(2)} />
  </Box>;
}

export function VolatilityIndexHistoryChart({ row, width, height }: ChartSize & { row: VolatilityBoardRow }) {
  const colors = useThemeColors();
  const points = useMemo(() => volatilityIndexHistoryPoints(row.history, row.missingDates), [row.history, row.missingDates]);
  if (!points.some((point) => Number.isFinite(point.close))) return <EmptyState title="Index history unavailable." />;
  return <StaticChartSurface points={points} calendarSpaced showTimeAxis width={width} height={height}
    colors={resolveChartPalette(colors, "neutral")} formatYAxisValue={(value) => value.toFixed(1)} />;
}
