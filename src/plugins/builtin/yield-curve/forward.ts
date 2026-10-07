/**
 * The curve priced for a year from now, read from today's curve. The method
 * is in docs/research-data.md (GC): par curves are bootstrapped to discount
 * factors and repriced as par bonds starting in a year; zero curves take the
 * forward zero rate between one year and one year plus each tenor.
 */

export interface CurveNode {
  id: string;
  years: number;
  /** Percent. */
  yield: number;
}

export type CurveBasis = "par" | "zero" | "benchmark" | "spread";

const EPSILON = 1e-9;

/** Linear in maturity between tenors, flat beyond the shortest one. */
function interpolate(nodes: readonly CurveNode[], years: number): number {
  const first = nodes[0]!;
  if (years <= first.years) return first.yield;
  for (let index = 1; index < nodes.length; index++) {
    const right = nodes[index]!;
    if (years <= right.years + EPSILON) {
      const left = nodes[index - 1]!;
      return left.yield + (right.yield - left.yield) * (years - left.years) / (right.years - left.years);
    }
  }
  return nodes.at(-1)!.yield;
}

/**
 * Discount factors from a par curve. A tenor shorter than a coupon period is a
 * money-market yield, discounted simply; from the first coupon date on, each
 * date's par yield (interpolated) prices a par bond whose earlier coupons are
 * already discounted.
 */
export function bootstrapDiscountFactors(nodes: readonly CurveNode[], couponsPerYear: number): Array<{ years: number; factor: number }> {
  const sorted = nodes.filter((node) => Number.isFinite(node.yield) && node.years > 0).toSorted((a, b) => a.years - b.years);
  if (!sorted.length) return [];
  const period = 1 / couponsPerYear;
  const factors = sorted.filter((node) => node.years < period - EPSILON)
    .map((node) => ({ years: node.years, factor: 1 / (1 + node.yield / 100 * node.years) }));
  let annuity = 0;
  const dates = Math.floor(sorted.at(-1)!.years * couponsPerYear + EPSILON);
  for (let index = 1; index <= dates; index++) {
    const years = index * period;
    const coupon = interpolate(sorted, years) / 100 / couponsPerYear;
    const factor = (1 - coupon * annuity) / (1 + coupon);
    annuity += factor;
    factors.push({ years, factor });
  }
  return factors;
}

/** Log-linear between known factors (flat forward rates); null past the last one. */
export function discountFactor(factors: readonly { years: number; factor: number }[], years: number): number | null {
  if (years <= 0) return 1;
  let left = { years: 0, factor: 1 };
  for (const right of factors) {
    if (years <= right.years + EPSILON) {
      const weight = (years - left.years) / (right.years - left.years);
      return Math.exp(Math.log(left.factor) + weight * (Math.log(right.factor) - Math.log(left.factor)));
    }
    left = right;
  }
  return null;
}

/**
 * Each tenor's yield a year from now as today's curve prices it, for the
 * tenors whose end still falls inside the curve. Empty for a curve that starts
 * past the horizon (TIPS, breakevens) or is a spread.
 */
export function forwardCurve(nodes: readonly CurveNode[], basis: CurveBasis, couponsPerYear: number, horizon = 1): CurveNode[] {
  const sorted = nodes.filter((node) => Number.isFinite(node.yield) && node.years > 0).toSorted((a, b) => a.years - b.years);
  if (basis === "spread" || sorted.length < 2 || sorted[0]!.years > horizon + EPSILON) return [];
  const longest = sorted.at(-1)!.years;
  const inside = sorted.filter((node) => horizon + node.years <= longest + EPSILON);
  if (basis === "zero") {
    // Continuously compounded: the rate earned from the horizon to horizon + T.
    const start = interpolate(sorted, horizon);
    return inside.map((node) => ({ ...node,
      yield: ((horizon + node.years) * interpolate(sorted, horizon + node.years) - horizon * start) / node.years }));
  }
  const factors = bootstrapDiscountFactors(sorted, couponsPerYear);
  const period = 1 / couponsPerYear;
  const atHorizon = discountFactor(factors, horizon);
  if (atHorizon == null) return [];
  return inside.flatMap((node) => {
    const end = discountFactor(factors, horizon + node.years);
    if (end == null) return [];
    // A money-market tenor forwards simply; a longer one is a par bond starting at the horizon.
    if (node.years < period - EPSILON) return [{ ...node, yield: 100 * (atHorizon / end - 1) / node.years }];
    const coupons = Math.round(node.years * couponsPerYear);
    let annuity = 0;
    for (let index = 1; index <= coupons; index++) annuity += discountFactor(factors, horizon + index * period) ?? Number.NaN;
    const par = 100 * couponsPerYear * (atHorizon - end) / annuity;
    return Number.isFinite(par) ? [{ ...node, yield: par }] : [];
  });
}
