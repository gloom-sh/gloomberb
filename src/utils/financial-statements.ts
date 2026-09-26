import type { FinancialStatement } from "../types/financials";
import { copyIncomeField, incomeFieldOwner, INCOME_STATEMENT_FIELDS, isIncomeStatementField } from "./income-statement";
import { hasStatementWithdrawals, mergeStatementWithdrawals, redactWithdrawnStatement } from "./statement-observations";
import { mergeStatementOperatingResult, normalizeStatementOperatingResult, reportedOperatingCohort, OPERATING_FIELDS } from "./operating-result";
import { EARNINGS_FIELDS, mergeReportedEarningsResult, ownedReportedEarningsCohort } from "./reported-earnings-result";
import { normalizeStatementEarningsResult } from "./earnings-result";

export const FINANCIAL_VINTAGE_NOTICE = "Latest available statements may include restatements. Historical as-of values are not reconstructed.";
export const SEC_EPS_BASIS_NOTICE = "SEC EPS uses corroborated split-adjusted share bases. Unverified bases are unavailable.";

const STATEMENT_METADATA_KEYS = new Set(["date", "dateSource", "providerDate", "dateEvidence", "currency", "availableAt", "fieldAvailability", "epsBasis", "fieldSources", "unavailableFields", "withdrawnObservations", "operatingResult", "operatingResultAggregation", "earningsResult", "unavailableEarnings"]);
const NEARBY_PERIOD_END_MS = 7 * 24 * 60 * 60 * 1_000;

/** An explicit field map is authoritative: omitted fields have unknown availability. */
export function statementFieldAvailability(row: FinancialStatement | undefined, field: string): string | undefined {
  if (OPERATING_FIELDS.includes(field as typeof OPERATING_FIELDS[number])) {
    const reported = reportedOperatingCohort(row);
    if (reported) return reported.filed;
  }
  const earnings = ownedReportedEarningsCohort(row);
  if (earnings && EARNINGS_FIELDS.includes(field as typeof EARNINGS_FIELDS[number])) return earnings.filed;
  const filed = isIncomeStatementField(field) ? row?.fieldSources?.[field]?.filed : undefined;
  const value = filed ?? (row?.fieldAvailability !== undefined ? row.fieldAvailability?.[field] : row?.availableAt);
  return value && Number.isFinite(Date.parse(value)) ? value : undefined;
}

/** A derived value is dated only when every input's availability is known. */
export function completeAvailability(values: readonly (string | null | undefined)[]): string | undefined {
  if (values.length === 0 || values.some((value) => !value || !Number.isFinite(Date.parse(value)))) return undefined;
  return values.reduce<string | undefined>((latest, value) => (
    !latest || Date.parse(value!) > Date.parse(latest) ? value! : latest
  ), undefined);
}

function metricKeys(...rows: Array<FinancialStatement | undefined>): string[] {
  return [...new Set(rows.flatMap((row) => Object.keys(row ?? {})))]
    .filter((key) => !STATEMENT_METADATA_KEYS.has(key));
}

function metricValue(row: FinancialStatement | undefined, key: string): unknown {
  return (row as unknown as Record<string, unknown> | undefined)?.[key];
}

function hasMetricValue(row: FinancialStatement | undefined, key: string): boolean {
  return typeof metricValue(row, key) === "number";
}

function hasAvailabilityEvidence(row: FinancialStatement | undefined): boolean {
  return !!row?.availableAt || Object.keys(row?.fieldAvailability ?? {}).length > 0;
}

function canonicalStatementDate(
  primary: FinancialStatement,
  fallback: FinancialStatement | undefined,
): string {
  if (!fallback) return primary.date;
  if (primary.dateSource === "sec") return primary.date;
  if (fallback.dateSource === "sec") return hasMatchingFinancialValues(primary, fallback) ? fallback.date : primary.date;
  if (isVerifiedCalendarAlias(primary, fallback)) return [primary.date, fallback.date].sort()[0]!;
  return hasAvailabilityEvidence(fallback) && !hasAvailabilityEvidence(primary)
    ? fallback.date
    : primary.date;
}

function statementDateTime(row: FinancialStatement): number | null {
  const time = Date.parse(`${row.date}T00:00:00Z`);
  return Number.isFinite(time) ? time : null;
}

export function areNearbyFinancialPeriodEnds(
  left: string | Date,
  right: string | Date,
): boolean {
  const leftTime = left instanceof Date ? left.getTime() : Date.parse(`${left}T00:00:00Z`);
  const rightTime = right instanceof Date ? right.getTime() : Date.parse(`${right}T00:00:00Z`);
  return Number.isFinite(leftTime)
    && Number.isFinite(rightTime)
    && Math.abs(leftTime - rightTime) <= NEARBY_PERIOD_END_MS;
}

function hasMatchingFinancialValues(left: FinancialStatement, right: FinancialStatement): boolean {
  if (left.currency && right.currency && left.currency !== right.currency) return false;
  const shared = metricKeys(left, right).filter((key) => hasMetricValue(left, key) && hasMetricValue(right, key));
  return shared.every((key) => Object.is(metricValue(left, key), metricValue(right, key)))
    && shared.filter((key) => Number.isFinite(metricValue(left, key)) && metricValue(left, key) !== 0).length >= 3;
}

function isVerifiedCalendarAlias(left: FinancialStatement, right: FinancialStatement): boolean {
  if (hasStatementWithdrawals(left) || hasStatementWithdrawals(right)) return false;
  if (left.operatingResult || right.operatingResult || left.earningsResult || right.earningsResult) return false;
  if (left.date === right.date || left.date.slice(0, 7) !== right.date.slice(0, 7)) return false;
  const monthEnd = (row: FinancialStatement) => {
    const date = new Date(`${row.date}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && new Date(date.getTime() + 86_400_000).getUTCDate() === 1;
  };
  if (monthEnd(left) === monthEnd(right)) return false;
  const fiscal = monthEnd(left) ? right : left;
  if (fiscal.dateSource !== "sec" && !hasAvailabilityEvidence(fiscal)) return false;
  // A month-end approximation can be weeks away for a 52/53-week issuer.
  // Require corroborating values, not just proximity or common zero fields.
  return hasMatchingFinancialValues(left, right);
}

export function coalesceFinancialPeriodAliases(rows: FinancialStatement[]): FinancialStatement[] {
  const result: FinancialStatement[] = [];
  for (const row of rows) {
    const index = result.findIndex((existing) => isVerifiedCalendarAlias(existing, row)
      || (existing.date === row.date && hasMatchingFinancialValues(existing, row)));
    if (index < 0) result.push(row);
    else result[index] = mergeFinancialStatementRows([result[index]!], [row])[0]!;
  }
  return result.sort((left, right) => left.date.localeCompare(right.date));
}

function matchFallbackRow(
  primary: FinancialStatement,
  fallbackRows: FinancialStatement[],
  usedFallbackRows: Set<FinancialStatement>,
): FinancialStatement | undefined {
  const exact = fallbackRows.find((row) => row.date === primary.date && !usedFallbackRows.has(row));
  if (exact) return exact;
  const primaryTime = statementDateTime(primary);
  if (primaryTime === null) return undefined;
  return fallbackRows
    .flatMap((row) => {
      if (usedFallbackRows.has(row)) return [];
      if (hasStatementWithdrawals(primary) || hasStatementWithdrawals(row)) return [];
      if (primary.operatingResult || row.operatingResult || primary.earningsResult || row.earningsResult) return [];
      const fallbackTime = statementDateTime(row);
      if (fallbackTime === null) return [];
      const distance = Math.abs(fallbackTime - primaryTime);
      return areNearbyFinancialPeriodEnds(primary.date, row.date) || isVerifiedCalendarAlias(primary, row) ? [{ row, distance }] : [];
    })
    .sort((left, right) => left.distance - right.distance || left.row.date.localeCompare(right.row.date))[0]?.row;
}

export function mergeFinancialStatementRows(
  primaryRows: FinancialStatement[],
  fallbackRows: FinancialStatement[],
): FinancialStatement[] {
  primaryRows = coalesceFinancialPeriodAliases(primaryRows.map(row => normalizeStatementEarningsResult(normalizeStatementOperatingResult(redactWithdrawnStatement(row)))));
  fallbackRows = coalesceFinancialPeriodAliases(fallbackRows.map(row => normalizeStatementEarningsResult(normalizeStatementOperatingResult(redactWithdrawnStatement(row)))));
  if (primaryRows.length === 0) return fallbackRows;
  if (fallbackRows.length === 0) return primaryRows;

  const usedFallbackRows = new Set<FinancialStatement>();
  const mergedRows = primaryRows.map((row) => {
    const fallback = matchFallbackRow(row, fallbackRows, usedFallbackRows);
    if (fallback) usedFallbackRows.add(fallback);
    // Keep the preferred report intact when providers use different reporting currencies.
    if (row.currency && fallback?.currency && row.currency !== fallback.currency) return row;
    let merged = {
      ...fallback,
      ...row,
      // Prefer the date backed by filing provenance. Generic provider merges
      // otherwise retain their primary provider's period identity.
      date: canonicalStatementDate(row, fallback),
    } as FinancialStatement;
    mergeStatementWithdrawals(merged, [row, ...(fallback ? [fallback] : [])]);
    const correctedFallbackEps = !row.epsBasis && !!fallback?.epsBasis && row.eps === fallback.epsBasis.originalValue;
    if (row.eps !== undefined && !row.epsBasis && !correctedFallbackEps) delete merged.epsBasis;
    // Period provenance belongs to the selected date. It must not leak from a
    // different fallback period or become publication evidence for any value.
    const dateOwner = [row, fallback].find((candidate) => candidate?.date === merged.date && candidate.dateSource === "sec")
      ?? (row.date === merged.date ? row : fallback);
    for (const key of ["dateSource", "providerDate", "dateEvidence"] as const) delete merged[key];
    if (dateOwner?.dateSource) merged.dateSource = dateOwner.dateSource;
    if (dateOwner?.providerDate) merged.providerDate = dateOwner.providerDate;
    if (dateOwner?.dateEvidence) merged.dateEvidence = dateOwner.dateEvidence;
    if (merged.dateSource === "sec" && row.date !== merged.date && !merged.providerDate) merged.providerDate = row.date;
    const fieldAvailability: Record<string, string> = {};
    const keys = [...new Set([...metricKeys(row, fallback), ...INCOME_STATEMENT_FIELDS])];

    for (const key of keys) {
      // Nearby vendor dates alone do not corroborate the identity of an income
      // observation. Retain the primary's own value and attribution together.
      if (isIncomeStatementField(key) && fallback && row.date !== fallback.date
        && (row.fieldSources?.[key] || fallback.fieldSources?.[key]
          || row.unavailableFields?.includes(key) || fallback.unavailableFields?.includes(key))) {
        const owner = row.date === merged.date ? row : fallback;
        copyIncomeField(merged, owner, key);
        if (typeof merged[key] === "number") {
          const available = statementFieldAvailability(owner, key);
          if (available) fieldAvailability[key] = available;
        }
        continue;
      }
      const incomeOwner = isIncomeStatementField(key) ? incomeFieldOwner(key, row, fallback) : undefined;
      if (incomeOwner && isIncomeStatementField(key)) {
        copyIncomeField(merged, incomeOwner, key);
        if (typeof merged[key] === "number") {
          const available = statementFieldAvailability(incomeOwner, key);
          if (available) fieldAvailability[key] = available;
        }
        continue;
      }
      // A refreshed SEC decision supersedes precisely the original EPS still
      // held by a primary cache; unrelated provider values keep their priority.
      if (key === "eps" && correctedFallbackEps) {
        if (fallback!.epsBasis!.status === "unresolved") delete merged.eps;
        else merged.eps = fallback!.eps;
        const available = statementFieldAvailability(fallback, "eps");
        if (available && merged.eps !== undefined) fieldAvailability.eps = available;
        continue;
      }
      if (key === "eps" && row.epsBasis?.status === "unresolved") {
        delete merged.eps;
        continue;
      }
      const primaryHasValue = hasMetricValue(row, key);
      const fallbackHasValue = hasMetricValue(fallback, key);
      if (!primaryHasValue && fallbackHasValue) {
        (merged as unknown as Record<string, unknown>)[key] = metricValue(fallback, key);
      }

      if (primaryHasValue) {
        const primaryAvailability = statementFieldAvailability(row, key);
        const valuesMatch = fallbackHasValue && Object.is(metricValue(row, key), metricValue(fallback, key));
        const availability = primaryAvailability
          ?? (valuesMatch ? statementFieldAvailability(fallback, key) : undefined);
        if (availability) fieldAvailability[key] = availability;
      } else if (fallbackHasValue) {
        const availability = statementFieldAvailability(fallback, key);
        if (availability) fieldAvailability[key] = availability;
      }
    }

    // A fallback row-level date cannot safely date a different primary value.
    // Retained fallback fields still carry their own per-field provenance.
    mergeStatementOperatingResult(merged, row, fallback);
    const reported = reportedOperatingCohort(merged);
    if (reported) for (const field of OPERATING_FIELDS) fieldAvailability[field] = reported.filed;
    mergeReportedEarningsResult(merged, [row, ...(fallback ? [fallback] : [])]);
    const earnings = ownedReportedEarningsCohort(merged);
    if (earnings) for (const field of EARNINGS_FIELDS) fieldAvailability[field] = earnings.filed;
    merged = redactWithdrawnStatement(merged);
    for (const key of keys) if (!hasMetricValue(merged, key)) delete fieldAvailability[key];
    const retainedMetricKeys = keys.filter((key) => hasMetricValue(merged, key));
    const availableAt = completeAvailability(retainedMetricKeys.map((key) => fieldAvailability[key]));
    if (availableAt) merged.availableAt = availableAt;
    else delete merged.availableAt;
    if (Object.keys(fieldAvailability).length > 0 || row.fieldAvailability !== undefined || fallback?.fieldAvailability !== undefined) merged.fieldAvailability = fieldAvailability;
    else delete merged.fieldAvailability;
    return merged;
  });

  for (const row of fallbackRows) {
    if (!usedFallbackRows.has(row)) mergedRows.push(row);
  }

  return mergedRows.sort((left, right) => left.date.localeCompare(right.date));
}
