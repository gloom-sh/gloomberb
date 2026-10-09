import type { ProjectedChartPoint } from "../../../../components/chart/core/data";
import type { ScatterChartPoint } from "../../../../components/chart/static";
import { colors } from "../../../../theme/colors";
import { formatNumber, formatSignificant } from "../../../../utils/format";
import type { CompositeAxisDomain } from "../../../../components/chart/composite/types";
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

function formatNullableNumber(value: number | null | undefined, decimals: number): string {
  return typeof value === "number" && Number.isFinite(value) ? formatNumber(value, decimals) : "-";
}

/**
 * A ratio's legend value at four significant digits, so a ratio of 0.000566
 * does not read 0.001. Whole index points and correlations keep their own fixed decimals.
 */
export const formatRatioValue = (value: number) => formatSignificant(value);

/** Ratio axis ticks need decimals that tell neighbours apart: 0.00040, 0.00045, 0.00050 where 0.001 would repeat. */
export function formatRatioAxisValue(value: number, domain: Pick<CompositeAxisDomain, "min" | "max">): string {
  if (Math.abs(value) >= 10) return formatNumber(value, 1);
  const span = Math.abs(domain.max - domain.min);
  const decimals = Number.isFinite(span) && span > 0 ? Math.min(10, Math.max(3, 1 - Math.floor(Math.log10(span)))) : 3;
  return formatNumber(value, decimals);
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
