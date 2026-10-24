import type { FinancialStatement, StatementFill, StatementFillField } from "../types/financials";
import { copyIncomeField, incomeFieldOwner, INCOME_STATEMENT_FIELDS, isIncomeStatementField } from "./income-statement";
import { mergeStatementGaps } from "./statement-gaps";

export const FINANCIAL_VINTAGE_NOTICE = "Latest available statements may include restatements. Historical as-of values are not reconstructed.";

/**
 * The closing lines of a statements report that say how far back it goes, from
 * the oldest period it served: the report holds no older ones, and `GF` reads
 * one metric over more periods, as far as its own history reaches. Empty when
 * no period has a date, so a report with nothing in it says nothing.
 */
export function statementHistoryNotes(
  period: "annual" | "quarterly",
  dates: readonly string[],
  symbol: string,
): string[] {
  const oldest = dates.filter((date) => /^\d{4}-\d{2}-\d{2}/.test(date)).map((date) => date.slice(0, 10)).sort()[0];
  if (!oldest) return [];
  return period === "annual"
    ? [
      `annual history from ${oldest.slice(0, 4)}; older years not served`,
      `earlier years, one metric at a time: gloom fn GF ${symbol} --period annual --periods 40`,
    ]
    : [
      `quarterly history from ${oldest}; older quarters not served`,
      `earlier quarters, one metric at a time: gloom fn GF ${symbol} --period quarterly --periods 40`,
    ];
}

/** How old a statement's latest period may be before a report says how old it is. */
const STALE_STATEMENT_MONTHS = 15;

/** Whole months from a YYYY-MM-DD period end to `now`, in UTC. */
function monthsSince(date: string, now: number): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!match) return null;
  const today = new Date(now);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return (today.getUTCFullYear() - year) * 12 + (today.getUTCMonth() + 1 - month) - (today.getUTCDate() < day ? 1 : 0);
}

/**
 * "Latest period 2024-06-30 is 27 months old.": what a statements report and
 * FA say when the latest period with the statement's lead figure (revenue,
 * total assets) ended more than 15 months ago, so a table that stops years
 * back never reads as current (EVN:ASX's balance sheet stopped at 2024-06-30
 * in October 2026). A newer period with only some figures (EVN's FY2025: EPS
 * alone) is named as such. `periods` are the table's columns, any order; a
 * column without a date (TTM) is not a period. Null when the latest period is
 * recent, or no column has a date.
 */
export function stalePeriodNote(
  periods: ReadonlyArray<{ date: string; lead: boolean }>,
  now = Date.now(),
): string | null {
  const dated = periods.filter(({ date }) => /^\d{4}-\d{2}-\d{2}/.test(date)).map(({ date, lead }) => ({ date: date.slice(0, 10), lead }));
  if (dated.length === 0) return null;
  const newest = dated.reduce((latest, period) => (period.date > latest ? period.date : latest), "");
  const lead = dated.filter((period) => period.lead).reduce((latest, period) => (period.date > latest ? period.date : latest), "") || newest;
  const [year, month, day] = lead.split("-").map(Number) as [number, number, number];
  // Over 15 months: past the same day 15 months on.
  if (!(now > Date.UTC(year, month - 1 + STALE_STATEMENT_MONTHS, day, 23, 59, 59, 999))) return null;
  const months = monthsSince(lead, now);
  return `Latest period ${lead} is ${months} months old${newest > lead ? `; ${newest} has only some figures` : ""}.`;
}

const FILL_SOURCES: Record<StatementFill["source"], string> = { asx: "ASX key statistics" };
const FILL_FIELDS: Record<StatementFillField, string> = {
  totalRevenue: "revenue", netIncome: "net income", totalAssets: "total assets", totalLiabilities: "total liabilities",
};

/**
 * "From ASX key statistics (read 2026-10-22): 2026-06-30 revenue, net income;
 * 2025-06-30 revenue, net income.": the years a statements table shows that
 * Gloom Cloud filled from the listing's exchange because the statements source
 * does not have them yet, newest first, with the lines taken. `shown` keeps the
 * lines the table has a row for. Null when no shown line was filled.
 */
export function filledPeriodsNote(
  statements: readonly Pick<FinancialStatement, "date" | "filledFrom">[],
  shown?: ReadonlySet<string>,
): string | null {
  const filled = statements.flatMap(({ date, filledFrom }) => {
    const source = filledFrom && FILL_SOURCES[filledFrom.source];
    const fields = (filledFrom?.fields ?? []).filter((field) => FILL_FIELDS[field] && (!shown || shown.has(field)));
    return source && fields.length > 0 ? [{ date: date.slice(0, 10), source, fields, read: filledFrom.retrievedAt.slice(0, 10) }] : [];
  }).sort((left, right) => right.date.localeCompare(left.date));
  if (filled.length === 0) return null;
  const read = filled.map((period) => period.read).sort().at(-1);
  return `From ${filled[0]!.source} (read ${read}): ${filled.map(({ date, fields }) => `${date} ${fields.map((field) => FILL_FIELDS[field]).join(", ")}`).join("; ")}.`;
}

/**
 * A merged row's fill, for the filled lines it still holds as the filled row
 * gave them; a line another source's row supplied is that source's.
 */
function retainedFill(merged: FinancialStatement, rows: Array<FinancialStatement | undefined>): StatementFill | undefined {
  for (const row of rows) {
    const fill = row?.filledFrom;
    const fields = fill?.fields.filter((field) => typeof merged[field] === "number" && Object.is(merged[field], row![field])) ?? [];
    if (fill && fields.length > 0) return { ...fill, fields };
  }
  return undefined;
}

export const SEC_EPS_BASIS_NOTICE = "SEC EPS uses corroborated split-adjusted share bases. Unverified bases are unavailable.";

const STATEMENT_METADATA_KEYS = new Set(["date", "dateSource", "providerDate", "dateEvidence", "currency", "availableAt", "fieldAvailability", "epsBasis", "fieldSources", "unavailableFields", "withdrawnObservations", "operatingResult", "operatingResultAggregation", "earningsResult", "unavailableEarnings", "filledFrom"]);
const NEARBY_PERIOD_END_MS = 7 * 24 * 60 * 60 * 1_000;

/** An explicit field map is authoritative: omitted fields have unknown availability. */
export function statementFieldAvailability(row: FinancialStatement | undefined, field: string): string | undefined {
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
  primaryRows = coalesceFinancialPeriodAliases(primaryRows);
  fallbackRows = coalesceFinancialPeriodAliases(fallbackRows);
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

    // A gap either report declares for the period survives the other's value.
    mergeStatementGaps(merged, [row, fallback]);
    const fill = retainedFill(merged, [row, fallback]);
    if (fill) merged.filledFrom = fill;
    else delete merged.filledFrom;
    // A fallback row-level date cannot safely date a different primary value.
    // Retained fallback fields still carry their own per-field provenance.
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
