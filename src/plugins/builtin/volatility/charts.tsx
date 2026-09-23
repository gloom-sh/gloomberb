import { useMemo } from "react";
import { CompositeChart, EmptyState, StaticChartSurface, type StaticChartOverlay } from "../../../components";
import { formatCompositeSeriesValue } from "../../../components/chart/composite/format";
import { resolveChartPalette } from "../../../components/chart/core/palette";
import { useThemeColors } from "../../../theme/theme-context";
import {
  volatilityCurveChartModel, volatilityHistorySeries, volatilityIndexHistoryPoints,
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

const HISTORY_PANELS = [{ id: "vol", height: 2 }, { id: "ratio", height: 1 }];

/** VIX 30D and 3M over the 3M/30D ratio on one date axis, with the flat line at 1.00. */
export function VolatilityHistoryChart({ fred, width, height }: ChartSize & { fred: FredVolatilityHistory }) {
  const colors = useThemeColors();
  const palette = resolveChartPalette(colors);
  const ratioColor = fred.termState === "inverted" ? colors.warning : palette.lineColor;
  const series = useMemo(() => volatilityHistorySeries(fred,
    { spot: colors.warning, threeMonth: colors.borderFocused, ratio: ratioColor, flat: colors.textDim }),
  [fred, colors.warning, colors.borderFocused, colors.textDim, ratioColor]);
  // The flat reference is drawn, not named: its level is the whole point of it.
  const legendSeries = useMemo(() => series.filter((entry) => entry.id !== "flat"), [series]);
  if (!series.some((entry) => entry.id !== "flat" && entry.points.some((point) => point.value != null))) {
    return <EmptyState title="VIX history unavailable." />;
  }
  return <CompositeChart series={series} legendSeries={legendSeries} panels={HISTORY_PANELS} width={width} height={height}
    navigable={false} showLegend showTimeAxis remoteKind="vix-history"
    formatValue={(value, entry) => entry.unitGroup === "ratio" ? value.toFixed(2) : formatCompositeSeriesValue(value, entry)}
    formatAxisValue={(value, domain) => domain.unitGroup === "ratio" ? value.toFixed(2) : `${value.toFixed(0)}%`}
    colors={{ background: palette.bgColor, grid: palette.gridColor, crosshair: palette.crosshairColor, text: colors.text,
      textDim: palette.axisColor, negative: colors.negative }} />;
}

export function VolatilityIndexHistoryChart({ row, width, height }: ChartSize & { row: VolatilityBoardRow }) {
  const colors = useThemeColors();
  const points = useMemo(() => volatilityIndexHistoryPoints(row.history, row.missingDates), [row.history, row.missingDates]);
  if (!points.some((point) => Number.isFinite(point.close))) return <EmptyState title="Index history unavailable." />;
  return <StaticChartSurface points={points} calendarSpaced showTimeAxis width={width} height={height}
    colors={resolveChartPalette(colors, "neutral")} formatYAxisValue={(value) => value.toFixed(1)} />;
}
