import type { FinancialStatement, StatementGapField } from "../../types/financials";
import { areNearbyFinancialPeriodEnds } from "../../utils/financial-statements";
import { withStatementGaps } from "../../utils/statement-gaps";

/**
 * Fiscal fourth quarters are rarely filed on their own: a US filer's Q4 is the
 * 10-K year less the Q3 10-Q's nine months, and vendors derive it the same
 * way. Two general rules keep that arithmetic honest.
 *
 * - Restatement guard. When an earlier period of the year was re-reported with
 *   a different value after the nine-month figure was filed, the full year and
 *   the nine months sit on different bases. The fourth quarter is then a gap
 *   for that line, in SEC rows and in the vendor's rows, until a restated
 *   nine-month comparative is filed.
 * - Vendor check. When the vendor's full year agrees with SEC's but its fourth
 *   quarter does not agree with SEC's (reported directly, or the year less
 *   nine months), the vendor's quarters use another measure and its fourth
 *   quarter absorbed the difference. That fourth quarter is a gap too, never a
 *   substituted value.
 *
 * See "Statement corrections" in docs/research-data.md.
 */

/** A company-facts duration observation of one line. */
export interface SecDurationFact {
  concept?: string;
  tagPriority?: number;
  start?: string;
  end?: string;
  val?: number;
  filed?: string;
  form?: string;
}

/** One fiscal year of an SEC line, as used to check fourth quarters. */
export interface SecFourthQuarter {
  /** Fiscal year end, which is also the fourth quarter's period end. */
  date: string;
  /** Statement lines the SEC line measures. */
  fields: StatementGapField[];
  annual: number;
  /** The reported fourth quarter, or the full year less nine months; absent when the restatement guard applies. */
  fourthQuarter?: number;
}

const DAY_MS = 86_400_000;
/** Largest vendor full-year difference that still counts as the same measure. */
const ANNUAL_TOLERANCE = 0.005;
/** Largest vendor fourth-quarter difference from SEC's that is accepted. */
const FOURTH_QUARTER_TOLERANCE = 0.05;
/** Filings up to the following year's 10-K, which carry this year's comparatives. */
const RESTATEMENT_WINDOW_DAYS = 460;

function days(start: string, end: string): number {
  return (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS;
}

type Fact = Required<Pick<SecDurationFact, "start" | "end" | "val" | "filed">> & SecDurationFact;

function isFact(fact: SecDurationFact): fact is Fact {
  return typeof fact.val === "number" && Number.isFinite(fact.val)
    && [fact.start, fact.end, fact.filed].every((date) => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date))
    && Number.isFinite(days(fact.start!, fact.end!));
}

function byFiled(left: Fact, right: Fact): number {
  return left.filed.localeCompare(right.filed);
}

/** The coarsest reporting unit either amount shows, up to millions. */
function roundingUnit(left: number, right: number): number {
  let unit = 1;
  for (const value of [left, right]) {
    let candidate = 1;
    while (candidate < 1_000_000 && value % (candidate * 10) === 0) candidate *= 10;
    unit = Math.max(unit, candidate);
  }
  return unit;
}

/**
 * A re-reported amount that differs beyond rounding: by more than the coarser
 * reporting unit (a filer that moves from thousands to millions re-rounds
 * every comparative) and by more than 0.05%.
 */
function isRevision(earlier: Fact, later: Fact): boolean {
  const difference = Math.abs(later.val - earlier.val);
  return difference > roundingUnit(earlier.val, later.val)
    && difference > 0.0005 * Math.max(Math.abs(earlier.val), Math.abs(later.val));
}

/** The fiscal years one SEC line can check, from its company-facts observations. */
export function secFourthQuarters(fields: StatementGapField[], observations: readonly SecDurationFact[]): SecFourthQuarter[] {
  const facts = observations.filter(isFact);
  const years = new Map<string, Fact>();
  for (const fact of facts) {
    const length = days(fact.start, fact.end);
    if (!/^10-K(?:\/A)?$/.test(fact.form ?? "") || length < 335 || length > 395) continue;
    // Tags are ordered fallbacks; within one tag the latest filing wins.
    const selected = years.get(fact.end);
    if (!selected || (fact.tagPriority ?? 0) < (selected.tagPriority ?? 0)
      || ((fact.tagPriority ?? 0) === (selected.tagPriority ?? 0) && fact.filed > selected.filed)) years.set(fact.end, fact);
  }
  const result: SecFourthQuarter[] = [];
  for (const year of years.values()) {
    const concept = facts.filter((fact) => fact.concept === year.concept);
    // A directly reported fourth quarter needs no arithmetic.
    const reported = concept.filter((fact) => {
      const length = days(fact.start, fact.end);
      return fact.end === year.end && length >= 60 && length <= 120;
    }).sort(byFiled).at(-1);
    if (reported) {
      result.push({ date: year.end, fields, annual: year.val, fourthQuarter: reported.val });
      continue;
    }
    const within = concept.filter((fact) => fact.start >= year.start && fact.end < year.end);
    const nineMonths = within.filter((fact) => {
      const length = days(fact.start, fact.end);
      return fact.start === year.start && length >= 250 && length <= 290;
    }).sort(byFiled).at(-1);
    if (!nineMonths) continue;
    // Restated comparatives arrive with the following year's filings; a
    // re-tagged period long after that is not a presentation of this year.
    const restated = within.some((later) => later.end <= nineMonths.end && later.filed > nineMonths.filed
      && days(year.end, later.filed) <= RESTATEMENT_WINDOW_DAYS
      && within.some((earlier) => earlier.start === later.start && earlier.end === later.end
        && earlier.filed < later.filed && isRevision(earlier, later)));
    result.push({
      date: year.end,
      fields,
      annual: year.val,
      ...(restated ? {} : { fourthQuarter: year.val - nineMonths.val }),
    });
  }
  return result.sort((left, right) => left.date.localeCompare(right.date));
}

/** SEC quarterly rows with a gap for each guarded fourth quarter SEC did not report directly. */
export function withGuardedFourthQuarters(rows: FinancialStatement[], checks: readonly SecFourthQuarter[]): FinancialStatement[] {
  const byDate = new Map(rows.map((row) => [row.date, row]));
  for (const check of checks) {
    if (check.fourthQuarter !== undefined) continue;
    const row = byDate.get(check.date) ?? { date: check.date, dateSource: "sec" as const, currency: "USD" };
    const fields = check.fields.filter((field) => typeof row[field] !== "number");
    if (fields.length) byDate.set(check.date, withStatementGaps(row, fields));
  }
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function sameUsdPeriod(row: FinancialStatement, date: string): boolean {
  return (row.currency === undefined || row.currency === "USD") && areNearbyFinancialPeriodEnds(row.date, date);
}

/** A vendor's quarterly rows with a gap for each fourth quarter SEC's filings contradict. */
export function withCheckedFourthQuarters(
  vendor: { annualStatements: readonly FinancialStatement[]; quarterlyStatements: readonly FinancialStatement[] },
  checks: readonly SecFourthQuarter[],
): FinancialStatement[] {
  return vendor.quarterlyStatements.map((row) => {
    const gaps = new Set<StatementGapField>();
    for (const check of checks) {
      if (!sameUsdPeriod(row, check.date)) continue;
      const annual = vendor.annualStatements.find((candidate) => sameUsdPeriod(candidate, check.date));
      for (const field of check.fields) {
        const fourthQuarter = row[field];
        if (typeof fourthQuarter !== "number" || !Number.isFinite(fourthQuarter)) continue;
        if (check.fourthQuarter === undefined) {
          gaps.add(field);
          continue;
        }
        const vendorAnnual = annual?.[field];
        if (typeof vendorAnnual !== "number" || !Number.isFinite(vendorAnnual)
          || Math.abs(vendorAnnual - check.annual) > ANNUAL_TOLERANCE * Math.abs(check.annual)) continue;
        if (Math.abs(fourthQuarter - check.fourthQuarter) > FOURTH_QUARTER_TOLERANCE * Math.abs(check.fourthQuarter)) gaps.add(field);
      }
    }
    return withStatementGaps(row, [...gaps]);
  });
}
