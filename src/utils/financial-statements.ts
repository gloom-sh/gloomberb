import type { FinancialStatement } from "../types/financials";

const STATEMENT_METADATA_KEYS = new Set(["date", "currency", "availableAt", "fieldAvailability"]);
const NEARBY_PERIOD_END_MS = 7 * 24 * 60 * 60 * 1_000;

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
      const fallbackTime = statementDateTime(row);
      if (fallbackTime === null) return [];
      const distance = Math.abs(fallbackTime - primaryTime);
      return areNearbyFinancialPeriodEnds(primary.date, row.date) ? [{ row, distance }] : [];
    })
    .sort((left, right) => left.distance - right.distance || left.row.date.localeCompare(right.row.date))[0]?.row;
}

export function mergeFinancialStatementRows(
  primaryRows: FinancialStatement[],
  fallbackRows: FinancialStatement[],
): FinancialStatement[] {
  if (primaryRows.length === 0) return fallbackRows;
  if (fallbackRows.length === 0) return primaryRows;

  const usedFallbackRows = new Set<FinancialStatement>();
  const mergedRows = primaryRows.map((row) => {
    const fallback = matchFallbackRow(row, fallbackRows, usedFallbackRows);
    if (fallback) usedFallbackRows.add(fallback);
    // Keep the preferred report intact when providers use different reporting currencies.
    if (row.currency && fallback?.currency && row.currency !== fallback.currency) return row;
    const merged = {
      ...fallback,
      ...row,
      // Prefer the date backed by filing provenance. Generic provider merges
      // otherwise retain their primary provider's period identity.
      date: canonicalStatementDate(row, fallback),
    } as FinancialStatement;
    const fieldAvailability: Record<string, string> = {};
    const keys = metricKeys(row, fallback);

    for (const key of keys) {
      const primaryHasValue = hasMetricValue(row, key);
      const fallbackHasValue = hasMetricValue(fallback, key);
      if (!primaryHasValue && fallbackHasValue) {
        (merged as unknown as Record<string, unknown>)[key] = metricValue(fallback, key);
      }

      if (primaryHasValue) {
        const primaryAvailability = row.fieldAvailability?.[key] ?? row.availableAt;
        const valuesMatch = fallbackHasValue && Object.is(metricValue(row, key), metricValue(fallback, key));
        const availability = primaryAvailability
          ?? (valuesMatch ? fallback?.fieldAvailability?.[key] ?? fallback?.availableAt : undefined);
        if (availability) fieldAvailability[key] = availability;
      } else if (fallbackHasValue) {
        const availability = fallback?.fieldAvailability?.[key] ?? fallback?.availableAt;
        if (availability) fieldAvailability[key] = availability;
      }
    }

    // A fallback row-level date cannot safely date a different primary value.
    // Retained fallback fields still carry their own per-field provenance.
    const primaryHasMetrics = keys.some((key) => hasMetricValue(row, key));
    const retainedMetricKeys = keys.filter((key) => hasMetricValue(merged, key));
    const completeFieldAvailability = retainedMetricKeys.length > 0
      && retainedMetricKeys.every((key) => !!fieldAvailability[key]);
    const availableAt = completeFieldAvailability
      ? Object.values(fieldAvailability).sort().at(-1)
      : row.availableAt ?? (!primaryHasMetrics ? fallback?.availableAt : undefined);
    if (availableAt) merged.availableAt = availableAt;
    else delete merged.availableAt;
    if (Object.keys(fieldAvailability).length > 0) merged.fieldAvailability = fieldAvailability;
    else delete merged.fieldAvailability;
    return merged;
  });

  for (const row of fallbackRows) {
    if (!usedFallbackRows.has(row)) mergedRows.push(row);
  }

  return mergedRows.sort((left, right) => left.date.localeCompare(right.date));
}
