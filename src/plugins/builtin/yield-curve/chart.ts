import type { CurveSeries } from "../../../components/chart/curve";
import type { YieldCurveLookbackId } from "./history";
import { curveAsOf, isYieldObservationDate, type YieldPoint } from "./treasury-data";

export function formatMaturityYears(years: number): string {
  return years < 1 ? `${(years * 12).toFixed(1)}M` : `${years.toFixed(1)}Y`;
}

export function formatYield(value: number): string {
  return `${value.toFixed(2)}%`;
}

/** A yield change in percentage points, read in basis points: `+7bp`, `-12bp`. */
export function formatYieldChange(change: number): string {
  const bp = Math.round(change * 100);
  return `${bp > 0 ? "+" : ""}${bp === 0 ? 0 : bp}bp`;
}

export function buildYieldCurveSeries(points: readonly YieldPoint[]): CurveSeries {
  return {
    id: "treasury", label: "Treasury", asOf: curveAsOf(points),
    points: points.filter((point) => Number.isFinite(point.maturityYears) && point.maturityYears > 0)
      .map((point) => ({ id: point.maturity, label: point.maturity, x: point.maturityYears,
        value: point.yield, asOf: point.asOf })),
  };
}

export type YieldLookbackCurves = Partial<Record<YieldCurveLookbackId, readonly YieldPoint[] | null>>;

export interface YieldTenorRow {
  id: string;
  years: number;
  yield: number | null;
  asOf: string | null;
  change1w: number | null;
  change1m: number | null;
}

const LOOKBACK_IDS: readonly YieldCurveLookbackId[] = ["1W", "1M"];

function yieldAt(points: readonly YieldPoint[] | null | undefined, maturity: string): number | null {
  const value = points?.find((point) => point.maturity === maturity)?.yield;
  return value != null && Number.isFinite(value) ? value : null;
}

/** One row per tenor: the yield and how far it moved since a week and a month back. */
export function yieldTenorRows(points: readonly YieldPoint[], lookbacks: YieldLookbackCurves = {}): YieldTenorRow[] {
  return points.filter((point) => Number.isFinite(point.maturityYears) && point.maturityYears > 0)
    .toSorted((left, right) => left.maturityYears - right.maturityYears)
    .map((point) => {
      const current = point.yield != null && Number.isFinite(point.yield) ? point.yield : null;
      const change = (id: YieldCurveLookbackId) => {
        const past = yieldAt(lookbacks[id], point.maturity);
        return current == null || past == null ? null : current - past;
      };
      return { id: point.maturity, years: point.maturityYears, yield: current,
        asOf: isYieldObservationDate(point.asOf) ? point.asOf : null, change1w: change("1W"), change1m: change("1M") };
    });
}

/**
 * The curve named in the table's words, then the look-backs that loaded as
 * ghosts. The query bar carries the session date, so the legend does not.
 */
export function yieldCurveChartSeries(
  points: readonly YieldPoint[],
  lookbacks: YieldLookbackCurves,
  colors: { current: string; ghosts: Readonly<Record<string, string>> },
): CurveSeries[] {
  const ghosts = LOOKBACK_IDS.flatMap((id): CurveSeries[] => {
    const curve = lookbacks[id];
    if (!curve?.some((point) => point.yield != null)) return [];
    return [{ ...buildYieldCurveSeries(curve), id, label: id, role: "ghost", color: colors.ghosts[id] }];
  });
  return [{ ...buildYieldCurveSeries(points), id: "yield", label: "Yield", asOf: undefined, role: "primary", color: colors.current },
    ...ghosts];
}
