import type { CurveSeries } from "../../../components/chart/curve";
import { formatBasisPoints } from "../../../utils/basis-points";
import type { CurveNode } from "./forward";
import type { YieldCurveLookbackId } from "./history";
import { curveAsOf, curveSpread, isYieldObservationDate, type YieldPoint } from "./treasury-data";

export function formatYield(value: number): string {
  return `${value.toFixed(2)}%`;
}

/** A yield change in percentage points, read in basis points: `+7bp`, `-12bp`. */
export function formatYieldChange(change: number): string {
  return formatBasisPoints(change);
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
  change1d: number | null;
  change1w: number | null;
  change1m: number | null;
  /** The compare curve's yield at this tenor, and this curve's minus it. */
  compare: number | null;
  changeCompare: number | null;
  /** The yield priced for a year from now. */
  forward: number | null;
}

export interface YieldTenorExtras {
  compare?: readonly YieldPoint[] | null;
  forward?: readonly CurveNode[];
}

/** The look-backs drawn as ghosts; the session before is a change, not a curve worth drawing. */
const GHOST_IDS: readonly YieldCurveLookbackId[] = ["1W", "1M"];

/**
 * A look-back value to read a move against. A tenor that has not published
 * since the look-back's session (a lagging or cached tenor, most often against
 * the session before) has no move yet, not a zero one.
 */
function pastYield(points: readonly YieldPoint[] | null | undefined, current: YieldPoint): number | null {
  const past = points?.find((point) => point.maturity === current.maturity);
  if (past?.yield == null || !Number.isFinite(past.yield)) return null;
  return isYieldObservationDate(past.asOf) && isYieldObservationDate(current.asOf) && past.asOf >= current.asOf ? null : past.yield;
}

/**
 * One row per tenor: the yield and how far it moved since the session before,
 * a week and a month back, and against a compare curve when one is set.
 */
export function yieldTenorRows(points: readonly YieldPoint[], lookbacks: YieldLookbackCurves = {},
  extras: YieldTenorExtras = {}): YieldTenorRow[] {
  return points.filter((point) => Number.isFinite(point.maturityYears) && point.maturityYears > 0)
    .toSorted((left, right) => left.maturityYears - right.maturityYears)
    .map((point) => {
      const current = point.yield != null && Number.isFinite(point.yield) ? point.yield : null;
      const change = (id: YieldCurveLookbackId) => {
        const past = pastYield(lookbacks[id], point);
        return current == null || past == null ? null : current - past;
      };
      const compared = extras.compare?.find((entry) => entry.maturity === point.maturity)?.yield;
      const compare = compared != null && Number.isFinite(compared) ? compared : null;
      return { id: point.maturity, years: point.maturityYears, yield: current,
        asOf: isYieldObservationDate(point.asOf) ? point.asOf : null,
        change1d: change("1D"), change1w: change("1W"), change1m: change("1M"),
        compare, changeCompare: current != null && compare != null ? current - compare : null,
        forward: extras.forward?.find((node) => node.id === point.maturity)?.yield ?? null };
    });
}

export interface YieldSpread {
  id: string;
  /** Long minus short yield, in percentage points like the tenor changes. */
  spread: number | null;
  /** Its move since the session before. */
  change1d: number | null;
}

/** The curve spreads rates desks quote, long tenor minus short. */
const SPREADS = [
  { id: "2s10s", short: "2Y", long: "10Y" },
  { id: "3m10y", short: "3M", long: "10Y" },
  { id: "5s30s", short: "5Y", long: "30Y" },
] as const;

/** Each spread and how far it moved since the session before; both need their two tenors from one session. */
export function yieldSpreads(points: readonly YieldPoint[], lookbacks: YieldLookbackCurves = {}): YieldSpread[] {
  return SPREADS.map(({ id, short, long }) => {
    const spread = curveSpread(points, short, long);
    const before = curveSpread(lookbacks["1D"], short, long);
    // Both tenors share a session here, so the short one dates the spread; one not newer than the look-back has no move yet.
    const session = points.find((point) => point.maturity === short)?.asOf;
    const beforeSession = lookbacks["1D"]?.find((point) => point.maturity === short)?.asOf;
    const moved = spread != null && before != null && !(session && beforeSession && beforeSession >= session);
    return { id, spread, change1d: moved ? spread - before : null };
  });
}

export interface YieldChartOverlays {
  /** The curve's name in the legend; "Yield" unless it is not one (a breakeven). */
  label?: string;
  /** A compare curve replaces the week and month ghosts. */
  compare?: { label: string; points: readonly YieldPoint[] } | null;
  forward?: readonly CurveNode[];
}

/**
 * The curve named in the table's words, then the look-backs that loaded as
 * ghosts (or the compare curve), then the forward curve. The query bar carries
 * the session date, so the legend does not.
 */
export function yieldCurveChartSeries(
  points: readonly YieldPoint[],
  lookbacks: YieldLookbackCurves,
  colors: { current: string; ghosts: Readonly<Record<string, string>>; compare?: string; forward?: string },
  overlays: YieldChartOverlays = {},
): CurveSeries[] {
  const ghosts = overlays.compare
    ? overlays.compare.points.some((point) => point.yield != null)
      ? [{ ...buildYieldCurveSeries(overlays.compare.points), id: "compare", label: overlays.compare.label, asOf: undefined,
        role: "ghost" as const, color: colors.compare }]
      : []
    : GHOST_IDS.flatMap((id): CurveSeries[] => {
      const curve = lookbacks[id];
      if (!curve?.some((point) => point.yield != null)) return [];
      return [{ ...buildYieldCurveSeries(curve), id, label: id, role: "ghost", color: colors.ghosts[id] }];
    });
  // Not a row of the table's own: its tenors stop a year short of the curve's end.
  const forward: CurveSeries[] = overlays.forward?.length ? [{
    id: "forward", label: "1Y fwd", role: "reference", color: colors.forward,
    points: overlays.forward.map((node) => ({ id: node.id, label: node.id, x: node.years, value: node.yield })),
  }] : [];
  return [{ ...buildYieldCurveSeries(points), id: "yield", label: overlays.label ?? "Yield", asOf: undefined, role: "primary",
    color: colors.current }, ...ghosts, ...forward];
}

/** The difference view: this curve minus the compare curve, in basis points, one column per tenor. */
export function yieldDifferenceSeries(rows: readonly YieldTenorRow[], label: string,
  colors: { positive: string; negative: string }): CurveSeries {
  return {
    id: "difference", label, role: "primary", style: "columns", color: colors.positive, negativeColor: colors.negative,
    points: rows.map((row) => ({ id: row.id, label: row.id, x: row.years,
      value: row.changeCompare == null ? null : Math.round(row.changeCompare * 10_000) / 100 })),
  };
}
