import type { CurveSeries } from "../../../components/chart/curve";
import { curveAsOf, type YieldPoint } from "./treasury-data";

export function formatMaturityYears(years: number): string {
  return years < 1 ? `${(years * 12).toFixed(1)}M` : `${years.toFixed(1)}Y`;
}

export function buildYieldCurveSeries(points: readonly YieldPoint[]): CurveSeries {
  return {
    id: "treasury", label: "Treasury", asOf: curveAsOf(points),
    points: points.filter((point) => Number.isFinite(point.maturityYears) && point.maturityYears > 0)
      .map((point) => ({ id: point.maturity, label: point.maturity, x: point.maturityYears,
        value: point.yield, asOf: point.asOf })),
  };
}
