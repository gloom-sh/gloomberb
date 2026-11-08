// Derives fiscal fourth quarters from their year and builds trailing-twelve-month statements.
import type { FinancialStatement } from "../../types/financials";
import { areNearbyFinancialPeriodEnds, completeAvailability, statementFieldAvailability } from "../../utils/financial-statements";
import { hasStatementGap } from "../../utils/statement-gaps";
import { trailingEpsAcrossFiscalYearEnd } from "../../utils/trailing-eps";
import { isFiniteNumber } from "../../utils/guards";
import {
  completeStatementAvailability,
  DAY_MS,
  type InternalStatement,
  type NumericStatementField,
  QUARTERLY_AVERAGE_FIELDS,
  QUARTERLY_FLOW_FIELDS,
  QUARTERLY_SNAPSHOT_FIELDS,
  setStatementNumber,
  statementNumber,
  statementTime,
  TTM_SUM_FIELDS,
} from "./statement";
import { mergeStatementsByPeriod } from "./statement-merge";

/** Internal calendar bucket for selecting adjacent inputs, not an issuer fiscal label. */
function calendarQuarterBucket(date: string): string {
  const parsedYear = Number(date.slice(0, 4));
  let year = Number.isFinite(parsedYear) ? parsedYear : 0;

  let month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  if (Number.isFinite(month) && Number.isFinite(day) && day <= 7 && (month - 1) % 3 === 0) {
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  const quarter = Number.isFinite(month) && month > 0 ? Math.ceil(month / 3) : 0;
  return quarter > 0 && year > 0 ? `${year} Q${quarter}` : date;
}

interface PrecedingQuarterInput {
  date: string;
  time: number;
  value: number;
  availableAt?: string;
}

function precedingQuarterInputs(
  quarterlyStatements: readonly FinancialStatement[],
  annualStatement: FinancialStatement,
  field: NumericStatementField,
): PrecedingQuarterInput[] {
  const annualTime = statementTime(annualStatement);
  if (!Number.isFinite(annualTime)) return [];

  const annualCategory = calendarQuarterBucket(annualStatement.date);
  const byCategory = new Map<string, PrecedingQuarterInput>();
  for (const statement of quarterlyStatements) {
    if (statement.currency !== annualStatement.currency) continue;
    const time = statementTime(statement);
    if (!Number.isFinite(time) || time >= annualTime || annualTime - time > 370 * DAY_MS) continue;
    const category = calendarQuarterBucket(statement.date);
    if (category === annualCategory) continue;
    const value = statementNumber(statement, field);
    if (value === null) continue;
    const previous = byCategory.get(category);
    if (!previous || statement.date.localeCompare(previous.date) > 0) {
      byCategory.set(category, {
        date: statement.date,
        time,
        value,
        availableAt: statementFieldAvailability(statement, field),
      });
    }
  }

  return [...byCategory.values()]
    .sort((left, right) => right.time - left.time)
    .slice(0, 3)
    .sort((left, right) => left.time - right.time);
}

/**
 * Completes additive fiscal Q4 flows from the annual total and three reported
 * quarters. EPS and weighted-average shares require reported quarter values;
 * neither is an additive flow. Snapshots come from the annual balance sheet. Derived
 * values become available only after the annual total and every quarterly
 * input used in the derivation are public.
 */
export function deriveQuarterlyStatements(
  quarterlyStatements: readonly FinancialStatement[],
  annualStatements: readonly FinancialStatement[],
): FinancialStatement[] {
  const mergedQuarterly = mergeStatementsByPeriod(quarterlyStatements);
  const byDate = new Map(mergedQuarterly.map((statement) => [statement.date, { ...statement }]));

  for (const annualStatement of mergeStatementsByPeriod(annualStatements)) {
    let target: InternalStatement = byDate.get(annualStatement.date) ?? { date: annualStatement.date, currency: annualStatement.currency };
    if (target.currency !== annualStatement.currency) continue;
    let changed = false;

    for (const field of QUARTERLY_FLOW_FIELDS) {
      // A line unavailable for the fourth quarter stays a gap: the full year
      // minus the other quarters would recreate the value a source withheld.
      if (hasStatementGap(target, field) || mergedQuarterly.some((statement) => (
        areNearbyFinancialPeriodEnds(statement.date, annualStatement.date) && hasStatementGap(statement, field)
      ))) continue;
      if (statementNumber(target, field) !== null) continue;
      const annualValue = statementNumber(annualStatement, field);
      if (annualValue === null) continue;
      const previousInputs = precedingQuarterInputs(mergedQuarterly, annualStatement, field);
      if (previousInputs.length !== 3) continue;
      const inputTimes = [...previousInputs.map((input) => input.time), statementTime(annualStatement)];
      if (inputTimes.some((time, index) => index > 0 && (time - inputTimes[index - 1]! < 60 * DAY_MS || time - inputTimes[index - 1]! > 120 * DAY_MS))) continue;
      const derived = annualValue - previousInputs.reduce((sum, input) => sum + input.value, 0);
      if (!Number.isFinite(derived)) continue;
      const availableAt = completeAvailability([
        statementFieldAvailability(annualStatement, field),
        ...previousInputs.map((input) => input.availableAt),
      ]);
      setStatementNumber(target, field, derived, availableAt);
      changed = true;
    }

    for (const field of QUARTERLY_SNAPSHOT_FIELDS) {
      if (statementNumber(target, field) !== null) continue;
      const annualValue = statementNumber(annualStatement, field);
      if (annualValue === null) continue;
      const availableAt = statementFieldAvailability(annualStatement, field);
      setStatementNumber(target, field, annualValue, availableAt);
      changed = true;
    }

    if (changed) {
      target.availableAt = completeStatementAvailability(target);
      byDate.set(target.date, target);
    }
  }

  return mergeStatementsByPeriod([...byDate.values()]);
}

export function buildTtmStatements(
  statements: readonly FinancialStatement[],
  annualStatements: readonly FinancialStatement[],
): InternalStatement[] {
  const sorted = mergeStatementsByPeriod(statements);
  const annual = mergeStatementsByPeriod(annualStatements);
  const result: InternalStatement[] = [];
  for (let index = 3; index < sorted.length; index += 1) {
    const window = sorted.slice(index - 3, index + 1);
    const latest = window.at(-1)!;
    const times = window.map(statementTime);
    if (new Set(window.map((statement) => statement.currency)).size > 1
      || times.some((time, index) => !Number.isFinite(time) || (index > 0 && (time - times[index - 1]! < 60 * DAY_MS || time - times[index - 1]! > 120 * DAY_MS)))) {
      // Retain the known period as a gap. Removing an incomplete window joins
      // the last usable TTM observation to the first recovered one.
      result.push({ date: latest.date, currency: latest.currency, availableAt: latest.availableAt,
        __timeSeriesTtm: true });
      continue;
    }

    const ttm: InternalStatement = {
      date: latest.date,
      currency: latest.currency,
      fieldAvailability: {},
      __timeSeriesTtm: true,
      __timeSeriesDerivedFields: [],
    };
    const unresolvedEps = window.find((statement) => statement.epsBasis?.status === "unresolved");
    if (unresolvedEps) ttm.epsBasis = unresolvedEps.epsBasis;
    const commonIncomeCount = window.filter((statement) => isFiniteNumber(statement.netIncomeCommonStockholders)).length;
    // Known common claims in some quarters cannot be ignored by substituting
    // aggregate income for the entire window or only its missing quarters.
    if ((commonIncomeCount > 0 && commonIncomeCount < window.length)
      || window.some(statement => statement.unavailableFields?.includes("netIncomeCommonStockholders"))) ttm.__timeSeriesIncompleteCommonIncome = true;
    const hasAverageShareInputs = window.some(statement => QUARTERLY_AVERAGE_FIELDS
      .some(field => statementNumber(statement, field) !== null));
    const hasCompleteAverageShares = QUARTERLY_AVERAGE_FIELDS.some(field => window.every(statement => {
      const value = statementNumber(statement, field);
      return value !== null && value > 0;
    }));
    // A missing quarter cannot replace a known weighted-period denominator
    // with a year-end ordinary/issued-share snapshot. Capitalization may still
    // use the snapshot; this guard is specific to the fallback earnings ratio.
    if (hasAverageShareInputs && !hasCompleteAverageShares) ttm.__timeSeriesIncompleteAverageShares = true;

    for (const field of [...TTM_SUM_FIELDS, ...QUARTERLY_AVERAGE_FIELDS]) {
      const values = window.map((statement) => statementNumber(statement, field));
      if (!values.every((value): value is number => value !== null)) continue;
      if (QUARTERLY_AVERAGE_FIELDS.includes(field) && !values.every(value => value > 0)) continue;
      (ttm as unknown as Record<string, unknown>)[field] = values.reduce((sum, value) => sum + value, 0)
        / (QUARTERLY_AVERAGE_FIELDS.includes(field) ? 4 : 1);
      ttm.__timeSeriesDerivedFields!.push(field);
      const availableAt = completeAvailability(window.map((statement) => (
        statementFieldAvailability(statement, field)
      )));
      if (availableAt) ttm.fieldAvailability![field] = availableAt;
    }
    // A fiscal Q4 the 10-K reports only inside its year: the year's EPS plus the quarters since, less the same quarters a year earlier.
    const acrossYearEnd = statementNumber(ttm, "eps") === null && !unresolvedEps
      ? trailingEpsAcrossFiscalYearEnd(window, sorted, annual, "eps") : null;
    if (acrossYearEnd) {
      ttm.eps = acrossYearEnd.value;
      ttm.__timeSeriesDerivedFields!.push("eps");
      const availableAt = completeAvailability(acrossYearEnd.inputs.map((statement) => statementFieldAvailability(statement, "eps")));
      if (availableAt) ttm.fieldAvailability!.eps = availableAt;
    }

    for (const field of QUARTERLY_SNAPSHOT_FIELDS) {
      const value = statementNumber(latest, field);
      if (value === null) continue;
      (ttm as unknown as Record<string, unknown>)[field] = value;
      const availableAt = statementFieldAvailability(latest, field);
      if (availableAt) ttm.fieldAvailability![field] = availableAt;
    }
    ttm.availableAt = completeStatementAvailability(ttm) ?? latest.availableAt;
    result.push(ttm);
  }
  return result;
}
