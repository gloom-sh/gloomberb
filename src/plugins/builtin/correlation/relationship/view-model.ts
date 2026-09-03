import type { ProjectedChartPoint } from "../../../../components/chart/core/data";
import type { MultiLineChartSeries } from "../../../../components/chart/static";
import type { ScatterChartPoint } from "../../../../components/chart/static";
import { colors } from "../../../../theme/colors";
import { formatNumber } from "../../../../utils/format";
import type {
  RelationshipAlignedPoint,
  RelationshipAnalysis,
  RelationshipRegressionStats,
  RelationshipReturnPoint,
} from "./model";

export function formatNullableNumber(value: number | null | undefined, decimals: number): string {
  return typeof value === "number" && Number.isFinite(value) ? formatNumber(value, decimals) : "-";
}

export function buildIndexedPriceSeries(
  aligned: RelationshipAlignedPoint[],
  leftSymbol: string,
  rightSymbol: string,
): MultiLineChartSeries[] {
  const first = aligned[0];
  if (!first) return [];
  return [
    {
      id: "left",
      label: leftSymbol,
      color: colors.positive,
      points: aligned.map((entry) => ({
        date: entry.date,
        value: (entry.leftClose / first.leftClose) * 100,
      })),
    },
    {
      id: "right",
      label: rightSymbol,
      color: "#4dabf7",
      points: aligned.map((entry) => ({
        date: entry.date,
        value: (entry.rightClose / first.rightClose) * 100,
      })),
    },
  ];
}

export function buildRelationshipRatioSeries(
  aligned: RelationshipAlignedPoint[],
  leftSymbol: string,
  rightSymbol: string,
  color: string,
): MultiLineChartSeries[] {
  return [{
    id: "ratio",
    label: `${leftSymbol}/${rightSymbol}`,
    color,
    points: aligned.map((entry) => ({ date: entry.date, value: entry.ratio })),
  }];
}

export function buildRelationshipCorrelationSeries(
  aligned: RelationshipAlignedPoint[],
  correlationPoints: ProjectedChartPoint[],
): MultiLineChartSeries[] {
  const correlationByTime = new Map(correlationPoints.map((point) => [point.date.getTime(), point.close] as const));
  return [{
    id: "correlation",
    label: "Rolling Corr",
    color: "#f6c85f",
    points: aligned.map((entry) => ({
      date: entry.date,
      value: correlationByTime.get(entry.date.getTime()) ?? null,
    })),
  }];
}

export function buildRelationshipScatterPointsForDate(
  returns: RelationshipReturnPoint[],
  cursorDate: Date | null,
): ScatterChartPoint[] {
  const cursorTime = cursorDate?.getTime() ?? null;
  return returns.map((entry, index) => ({
    x: entry.rightReturn * 100,
    y: entry.leftReturn * 100,
    highlight: cursorTime === null
      ? index === returns.length - 1
      : entry.date.getTime() === cursorTime,
  }));
}

export function findRelationshipAlignedPoint(
  aligned: RelationshipAlignedPoint[],
  cursorDate: Date | null,
): RelationshipAlignedPoint | null {
  if (aligned.length === 0) return null;
  if (!cursorDate) return aligned.at(-1) ?? null;
  return aligned.find((entry) => entry.date.getTime() === cursorDate.getTime()) ?? aligned.at(-1) ?? null;
}

export function findRelationshipCorrelationAtDate(
  points: ProjectedChartPoint[],
  cursorDate: Date | null,
): number | null {
  if (!cursorDate) return points.at(-1)?.close ?? null;
  return points.find((point) => point.date.getTime() === cursorDate.getTime())?.close ?? null;
}

export function buildRelationshipMetricsRows(
  stats: RelationshipRegressionStats | null,
  analysis: RelationshipAnalysis,
): Array<{ label: string; value: string }> {
  return [
    { label: "Beta", value: formatNullableNumber(stats?.beta, 3) },
    { label: "Alpha", value: `${formatNullableNumber(stats?.alpha, 3)}%` },
    { label: "R", value: formatNullableNumber(stats?.r, 3) },
    { label: "R2", value: formatNullableNumber(stats?.rSquared, 3) },
    { label: "Std Err", value: formatNullableNumber(stats?.stdError, 3) },
    { label: "Obs", value: String(stats?.sampleSize ?? analysis.returns.length) },
    { label: "Aligned", value: String(analysis.aligned.length) },
  ];
}
