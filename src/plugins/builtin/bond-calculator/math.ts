export type BondDayCount = "act-act-icma" | "30-360-us";
export type BondFrequency = 1 | 2 | 4;

export interface BondTerms {
  settlement: string;
  maturity: string;
  couponPercent: number;
  frequency: BondFrequency;
  dayCount: BondDayCount;
  /** Explicit schedule choice; a maturity date does not establish this convention. */
  endOfMonth: boolean;
}

export interface BondPeriod {
  previousCoupon: string;
  nextCoupon: string;
  couponDates: string[];
  couponAmount: number;
  accruedInterest: number;
  firstPeriodFraction: number;
}

export interface BondCashFlow {
  date: string;
  amount: number;
  years: number;
  presentValue: number;
}

export interface BondAnalytics extends BondPeriod {
  yieldPercent: number;
  cleanPrice: number;
  dirtyPrice: number;
  macaulayDuration: number;
  modifiedDuration: number;
  convexity: number;
  /** Price points per 100 face for a 1bp yield shift. */
  dv01: number;
  cashFlows: BondCashFlow[];
}

const DAY_MS = 86_400_000;
function parseDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Use a valid YYYY-MM-DD date");
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error("Use a valid YYYY-MM-DD date");
  return date;
}
const dateText = (date: Date) => date.toISOString().slice(0, 10);
const actualDays = (start: Date, end: Date) => (end.getTime() - start.getTime()) / DAY_MS;
function monthEnd(date: Date): number {
  const end = new Date(date);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  return end.getUTCDate();
}
function couponDate(maturity: Date, monthsBefore: number, endOfMonth: boolean): Date {
  const date = new Date(maturity);
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - monthsBefore);
  date.setUTCDate(endOfMonth ? monthEnd(date) : Math.min(maturity.getUTCDate(), monthEnd(date)));
  return date;
}

/** US 30/360: last-February start is day 30; a last-February end adjusts
 * only when both endpoints are last-February. This differs from 30E/360. */
export function days360US(start: string, end: string): number {
  const a = parseDate(start), b = parseDate(end);
  let first = a.getUTCDate(), last = b.getUTCDate();
  const firstFebruaryEnd = a.getUTCMonth() === 1 && first === monthEnd(a);
  const lastFebruaryEnd = b.getUTCMonth() === 1 && last === monthEnd(b);
  if (firstFebruaryEnd && lastFebruaryEnd) last = 30;
  if (firstFebruaryEnd || first === 31) first = 30;
  if (last === 31 && first >= 30) last = 30;
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 360 + (b.getUTCMonth() - a.getUTCMonth()) * 30 + last - first;
}

/** Regular coupon bonds, no odd first/last periods, ex-coupon window or business-day adjustment. */
export function bondPeriod(terms: BondTerms): BondPeriod {
  const settlement = parseDate(terms.settlement), maturity = parseDate(terms.maturity);
  if (maturity <= settlement) throw new Error("Maturity must follow settlement");
  if (actualDays(settlement, maturity) > 36525) throw new Error("Maturity must be within 100 years");
  if (![1, 2, 4].includes(terms.frequency)) throw new Error("Coupon frequency must be annual, semiannual or quarterly");
  if (!Number.isFinite(terms.couponPercent) || terms.couponPercent < 0) throw new Error("Coupon must be nonnegative");
  if (!["act-act-icma", "30-360-us"].includes(terms.dayCount)) throw new Error("Unsupported day count");
  if (terms.endOfMonth && maturity.getUTCDate() !== monthEnd(maturity)) throw new Error("End-of-month schedule requires a month-end maturity");
  const dates: Date[] = [];
  let previous = maturity;
  for (let period = 0; period <= 401; period++) {
    const date = couponDate(maturity, period * 12 / terms.frequency, terms.endOfMonth);
    if (date <= settlement) { previous = date; break; }
    dates.push(date);
  }
  dates.reverse();
  const next = dates[0]!;
  const couponAmount = terms.couponPercent / terms.frequency;
  const denominator = terms.dayCount === "act-act-icma" ? actualDays(previous, next) : 360 / terms.frequency;
  const accruedDays = terms.dayCount === "act-act-icma" ? actualDays(previous, settlement) : days360US(dateText(previous), terms.settlement);
  const remainingDays = terms.dayCount === "act-act-icma" ? actualDays(settlement, next) : days360US(terms.settlement, dateText(next));
  // On a coupon date, the next payment is a full coupon period away. A clipped
  // February endpoint must not create an extra fraction in a regular schedule.
  const firstPeriodFraction = previous.getTime() === settlement.getTime() ? 1 : remainingDays / denominator;
  return { previousCoupon: dateText(previous), nextCoupon: dateText(next), couponDates: dates.map(dateText), couponAmount,
    accruedInterest: couponAmount * accruedDays / denominator, firstPeriodFraction };
}

function discountedFlows(period: BondPeriod, frequency: BondFrequency, yieldPercent: number): BondCashFlow[] {
  if (!Number.isFinite(yieldPercent) || yieldPercent <= -100 * frequency) throw new Error(`Yield must exceed ${-100 * frequency}%`);
  const logGrowth = Math.log1p(yieldPercent / (100 * frequency));
  return period.couponDates.map((date, index, dates) => {
    const exponent = period.firstPeriodFraction + index;
    const amount = period.couponAmount + (index === dates.length - 1 ? 100 : 0);
    return { date, amount, years: exponent / frequency, presentValue: amount === 0 ? 0 : amount * Math.exp(-exponent * logGrowth) };
  });
}

export function priceBond(terms: BondTerms, yieldPercent: number): BondAnalytics {
  const period = bondPeriod(terms);
  const cashFlows = discountedFlows(period, terms.frequency, yieldPercent);
  const dirtyPrice = cashFlows.reduce((sum, flow) => sum + flow.presentValue, 0);
  if (!Number.isFinite(dirtyPrice) || dirtyPrice <= 0) throw new Error("Price is outside the supported numeric range");
  const q = 1 + yieldPercent / (100 * terms.frequency);
  const macaulayDuration = cashFlows.reduce((sum, flow) => sum + flow.years * flow.presentValue, 0) / dirtyPrice;
  const modifiedDuration = macaulayDuration / q;
  const convexity = cashFlows.reduce((sum, flow) => sum + flow.presentValue * flow.years * (flow.years + 1 / terms.frequency), 0) / (dirtyPrice * q * q);
  return { ...period, yieldPercent, dirtyPrice, cleanPrice: dirtyPrice - period.accruedInterest,
    macaulayDuration, modifiedDuration, convexity, dv01: dirtyPrice * modifiedDuration / 10_000, cashFlows };
}

export function solveBondYield(terms: BondTerms, cleanPrice: number): number {
  const period = bondPeriod(terms);
  if (!Number.isFinite(cleanPrice) || cleanPrice <= 0) throw new Error("Clean price must be positive");
  const target = cleanPrice + period.accruedInterest;
  const dirtyAt = (yieldPercent: number) => discountedFlows(period, terms.frequency, yieldPercent).reduce((sum, flow) => sum + flow.presentValue, 0);
  let lower = -100 * terms.frequency + 1e-7;
  let upper = Math.max(100, terms.couponPercent + 20);
  for (let step = 0; step < 30 && dirtyAt(upper) > target; step++) upper *= 2;
  if (dirtyAt(upper) > target || dirtyAt(lower) < target) throw new Error("No yield in the supported numeric range");
  for (let step = 0; step < 220; step++) {
    const middle = (lower + upper) / 2;
    const difference = dirtyAt(middle) - target;
    if (Math.abs(difference) <= 1e-11 * Math.max(1, target)) return middle;
    if (difference > 0) lower = middle;
    else upper = middle;
  }
  return (lower + upper) / 2;
}

export interface TreasuryBenchmarkPoint { maturityYears: number; yieldPercent: number | null; asOf: string | null }
export interface TreasurySpread { benchmarkPercent: number; spreadBps: number; asOf: string; maturityYears: number }
/** Nominal yield spread to an interpolated Treasury par yield, never a Z-spread. */
export function treasurySpread(terms: BondTerms, yieldPercent: number, curve: readonly TreasuryBenchmarkPoint[]): TreasurySpread | null {
  const maturityYears = actualDays(parseDate(terms.settlement), parseDate(terms.maturity)) / 365.25;
  if (!Number.isFinite(yieldPercent) || maturityYears <= 0) return null;
  const points = curve.filter((point) => Number.isFinite(point.maturityYears) && point.maturityYears > 0
    && point.yieldPercent != null && Number.isFinite(point.yieldPercent)).toSorted((a, b) => a.maturityYears - b.maturityYears);
  if (new Set(points.map((point) => point.maturityYears)).size !== points.length) return null;
  const before = points.findLast((point) => point.maturityYears <= maturityYears);
  const after = points.find((point) => point.maturityYears >= maturityYears);
  if (!before || !after || !before.asOf || before.asOf !== after.asOf) return null;
  try { parseDate(before.asOf); } catch { return null; }
  const weight = before === after ? 0 : (maturityYears - before.maturityYears) / (after.maturityYears - before.maturityYears);
  const benchmarkPercent = before.yieldPercent! + weight * (after.yieldPercent! - before.yieldPercent!);
  return { benchmarkPercent, spreadBps: (yieldPercent - benchmarkPercent) * 100, asOf: before.asOf, maturityYears };
}
