import type { ProjectedChartPoint } from "../../../../components/chart/core/data";
import type { ScatterChartPoint } from "../../../../components/chart/static";
import { colors } from "../../../../theme/colors";
import { formatNumber } from "../../../../utils/format";
import type { StatItem } from "../../../../components/ui";
import type {
  RelationshipAlignedPoint,
  RelationshipRegressionStats,
  RelationshipReturnPoint,
} from "./model";

export interface MultiLineChartSeries {
  id: string;
  label: string;
  color: string;
  points: Array<{ date: Date; value: number | null }>;
}

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
    label: "Rolling corr",
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

/**
 * The regression of the first ticker's daily returns on the second's, as the
 * pane's summary figures. R² rides with R; sample counts are left out.
 */
export function buildRelationshipStatItems(stats: RelationshipRegressionStats | null): StatItem[] {
  if (!stats) return [];
  return [
    { id: "beta", label: "Beta", value: formatNullableNumber(stats.beta, 3) },
    { id: "alpha", label: "Alpha", value: `${formatNullableNumber(stats.alpha, 3)}%`, detail: "daily" },
    { id: "r", label: "R", value: formatNullableNumber(stats.r, 3), detail: `R² ${formatNullableNumber(stats.rSquared, 3)}` },
    { id: "stdErr", label: "Std err", value: formatNullableNumber(stats.stdError, 3) },
  ];
}
