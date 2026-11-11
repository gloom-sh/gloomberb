import type { FinancialStatement, ResultsFillField, StatementFill, StatementFillField, TickerFinancials } from "../types/financials";
import { settleWithin } from "./async-deadline";
import { fiscalYearEndMonth } from "./fiscal-period";
import { logFailure } from "./log-failure";
import { copyIncomeField, incomeFieldOwner, INCOME_STATEMENT_FIELDS, isIncomeStatementField } from "./income-statement";
import { mergeStatementGaps } from "./statement-gaps";

export const FINANCIAL_VINTAGE_NOTICE = "Latest available statements may include restatements. Historical as-of values are not reconstructed.";

/** The oldest dated period of a report's columns (a TTM column has no date), or null when none has one. */
function oldestPeriod(dates: readonly string[]): string | null {
  return dates.filter((date) => /^\d{4}-\d{2}-\d{2}/.test(date)).map((date) => date.slice(0, 10)).sort()[0] ?? null;
}

/**
 * The closing lines of a statements report that say how far back it goes, from
 * the oldest period it served: the report holds no older ones. `older` says
 * whether `GF`, which reads one metric from the listing's extended history
 * (`hasOlderStatements`), goes further back: it is pointed to only then, and
 * when it does not, the listing has no older ones at all (IAG on LSE: its
 * statements start in 2022, in GF too). Null when that could not be told in
 * time: the report then says nothing of older periods. Empty too when no
 * period has a date, so a report with nothing in it says nothing.
 */
export function statementHistoryNotes(
  period: "annual" | "quarterly",
  dates: readonly string[],
  symbol: string,
  older: boolean | null,
): string[] {
  const oldest = oldestPeriod(dates);
  if (!oldest || older === null) return [];
  const [from, unit] = period === "annual" ? [oldest.slice(0, 4), "years"] : [oldest, "quarters"];
  if (older === false) return [`${period} history from ${from}; older ${unit} not available for this listing`];
  return [
    `${period} history from ${from}; older ${unit} not served`,
    ...older ? [`earlier ${unit}, one metric at a time: gloom fn GF ${symbol} --period ${period} --periods 40`] : [],
  ];
}

/**
 * How long a statements report waits on the extended history for its
 * older-periods note, as a lock note waits on its routes' checks: a read still
 * out then leaves the report on time, without the note. The read goes on and
 * warms the cache for the next report.
 */
const OLDER_STATEMENTS_WAIT_MS = 3_000;

/**
 * Whether the listing's extended statement history, which `GF` reads, has a
 * period older than the oldest of `dates`, a report's columns: a US filer's
 * filings reach years back; a listing abroad has nothing past what the report
 * served. Null when the history could not be read within `waitMs`.
 */
export async function hasOlderStatements(
  loadExtended: () => Promise<Pick<TickerFinancials, "annualStatements" | "quarterlyStatements">>,
  period: "annual" | "quarterly",
  dates: readonly string[],
  waitMs = OLDER_STATEMENTS_WAIT_MS,
): Promise<boolean | null> {
  const oldest = oldestPeriod(dates);
  if (!oldest) return null;
  const read = Promise.resolve().then(loadExtended).catch((error: unknown) => {
    logFailure("utils.financial-statements", "Reading the extended statement history failed")(error);
    throw error;
  });
  const extended = await settleWithin(read, waitMs);
  if (!extended) return null;
  const rows = period === "annual" ? extended.annualStatements : extended.quarterlyStatements;
  return rows.some((row) => /^\d{4}-\d{2}-\d{2}/.test(row.date) && row.date.slice(0, 10) < oldest);
}

/** Venues whose companies report half-yearly and yearly, with no quarterly statements: Australia's (ASX, and Cboe Australia, which trades ASX companies) and New Zealand's. */
const HALF_YEARLY_VENUES = new Set(["ASX", "CXA", "NZX"]);
const DAY_MS = 86_400_000;

/**
 * Whether a listing's company reports half-yearly rather than quarterly: its
 * periods are halves (periodsAreHalves), or it lists on a venue whose
 * companies do (Qantas on ASX) and its interim statements show no quarters.
 * The venue never outweighs the periods: ResMed reports quarters on ASX.
 */
export function reportsHalfYearly(
  exchange: string | null | undefined,
  quarterly: readonly Pick<FinancialStatement, "date">[],
  annual: readonly Pick<FinancialStatement, "date">[] = [],
): boolean {
  if (periodsAreHalves(quarterly, annual)) return true;
  return !!exchange && HALF_YEARLY_VENUES.has(exchange.toUpperCase()) && !periodsAreQuarters(quarterly);
}

/** Whether consecutive interim statements are a quarter apart somewhere: a quarterly reporter, whatever its venue. */
function periodsAreQuarters(quarterly: readonly Pick<FinancialStatement, "date">[]): boolean {
  const times = quarterly.map(({ date }) => Date.parse(`${date.slice(0, 10)}T00:00:00Z`)).filter(Number.isFinite).sort((a, b) => a - b);
  return times.slice(1).some((time, index) => {
    const days = (time - times[index]!) / DAY_MS;
    return days > 60 && days < 120;
  });
}

/**
 * Whether a listing's interim statements are halves, read from the periods
 * alone: they are half a year apart, or, with the years, they all close the
 * first half of a fiscal year (Pop Mart's Junes beside its Decembers).
 */
function periodsAreHalves(
  quarterly: readonly Pick<FinancialStatement, "date">[],
  annual: readonly Pick<FinancialStatement, "date">[],
): boolean {
  const times = quarterly.map(({ date }) => Date.parse(`${date.slice(0, 10)}T00:00:00Z`)).filter(Number.isFinite).sort((a, b) => a - b);
  const gaps = times.slice(1).map((time, index) => (time - times[index]!) / DAY_MS);
  if (gaps.length > 0 && gaps.every((days) => days > 150 && days < 215)) return true;
  const yearEnd = fiscalYearEndMonth(annual);
  return quarterly.length > 1 && yearEnd != null && quarterly.every(({ date }) => halfYearLabel(date, yearEnd)?.startsWith("H1") === true);
}

/**
 * A half-year period as its issuer names it: `H1 2026` for the half to June of
 * a calendar year, `H2 FY27` for the half to March of a year ending in March.
 * Null for a date that closes no half of the fiscal year.
 */
function halfYearLabel(date: string, yearEndMonth: number | null): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!match || yearEndMonth == null) return null;
  let [year, month] = [Number(match[1]), Number(match[2])];
  // A 52/53-week half that ends in a month's first week closes the month before.
  if (Number(match[3]) <= 7) [year, month] = month === 1 ? [year - 1, 12] : [year, month - 1];
  const offset = (month - yearEndMonth + 12) % 12;
  if (offset !== 0 && offset !== 6) return null;
  const fiscalYear = month <= yearEndMonth ? year : year + 1;
  const half = offset === 6 ? "H1" : "H2";
  return yearEndMonth === 12 ? `${half} ${fiscalYear}` : `${half} FY${String(fiscalYear).slice(-2)}`;
}

/**
 * What a latest-period growth figure compares for a company that reports
 * half-yearly: "H1 2026 vs H1 2025" (Pop Mart's revenue growth on 2026-11-11
 * is its half to June against the year before's, not a quarter's). Null when
 * the interim periods are not halves, whose figure is the last quarter's, and
 * when the latest half cannot be named.
 */
export function halfYearGrowthPeriod(
  financials: Pick<TickerFinancials, "annualStatements" | "quarterlyStatements">,
): string | null {
  // From the periods, never the venue: a quarterly reporter on ASX (ResMed, James Hardie) keeps its quarter.
  if (!periodsAreHalves(financials.quarterlyStatements, financials.annualStatements)) return null;
  const latest = financials.quarterlyStatements.map(({ date }) => date.slice(0, 10)).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort().at(-1);
  if (!latest) return null;
  const yearEnd = fiscalYearEndMonth(financials.annualStatements);
  const label = halfYearLabel(latest, yearEnd);
  const prior = halfYearLabel(`${Number(latest.slice(0, 4)) - 1}${latest.slice(4)}`, yearEnd);
  return label && prior ? `${label} vs ${prior}` : null;
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

const FILL_SOURCES: Record<StatementFill["source"], string> = { asx: "ASX key statistics", results: "the company's results announcements" };
const FILL_FIELDS: Record<StatementFillField | ResultsFillField, string> = {
  totalRevenue: "revenue", netIncome: "net income", totalAssets: "total assets", totalLiabilities: "total liabilities",
  grossProfit: "gross profit", operatingIncome: "operating income", basicEps: "EPS", eps: "diluted EPS",
  operatingCashFlow: "operating cash flow", capitalExpenditure: "capex", freeCashFlow: "free cash flow",
  cashAndCashEquivalents: "cash", totalDebt: "total debt", totalEquity: "equity", commonStockEquity: "equity",
  totalEquityGrossMinorityInterest: "total equity",
};

/** The day a row's lines filled from the company's results announcement were first published; null for any other row. */
export function announcedDate(row: Pick<FinancialStatement, "date" | "filledFrom">): string | null {
  const fill = row.filledFrom;
  if (fill?.source !== "results" || fill.fields.length === 0) return null;
  return fillDate(fill, row.date.slice(0, 10)).date || null;
}

/**
 * When a filled row's figures were published or read: ASX's read, or the
 * first of its documents published after its period ended. A trailing twelve
 * months to a half also lists the year's documents, which came out before
 * the half did: it is dated by the half's results.
 */
function fillDate(fill: StatementFill, periodEnd: string): { label: "read" | "published"; date: string } {
  if (fill.source === "asx") return { label: "read", date: fill.retrievedAt.slice(0, 10) };
  const dates = fill.documents.map((document) => document.publishedAt.slice(0, 10)).sort();
  return { label: "published", date: dates.find((date) => date >= periodEnd) ?? dates[0] ?? "" };
}

type FilledRow = Pick<FinancialStatement, "date" | "filledFrom"> & { aggregation?: { periodEnd?: string; kind?: string; basis?: string } };

/** A table's filled periods with the lines it shows, newest first; a TTM row's end is that of the period it runs to. */
function filledPeriods(statements: readonly FilledRow[], shown?: ReadonlySet<string>) {
  return statements.flatMap(({ date, filledFrom, aggregation }) => {
    const source = filledFrom && FILL_SOURCES[filledFrom.source];
    const fields = [...new Set((filledFrom?.fields ?? [])
      .filter((field) => FILL_FIELDS[field] && (!shown || shown.has(field)))
      .map((field) => FILL_FIELDS[field]))];
    if (!source || !filledFrom || fields.length === 0) return [];
    const end = date.slice(0, 10);
    const months = filledFrom.source === "results" && filledFrom.periodMonths ? `${filledFrom.periodMonths} months to ` : "";
    return [{ end, period: `${months}${end}`, source, fields, stamp: fillDate(filledFrom, (aggregation?.periodEnd ?? date).slice(0, 10)),
      periodEnd: (aggregation?.periodEnd ?? date).slice(0, 10) }];
  }).sort((left, right) => right.end.localeCompare(left.end));
}

/**
 * The periods `filledPeriodsNote` dates by a results announcement and the day
 * it gives ("2026-06-30", "2026-08-20"), so a line naming the same
 * announcement for the same period is not said twice.
 */
export function filledPeriodPublications(
  statements: readonly FilledRow[],
  shown?: ReadonlySet<string>,
): Array<{ periodEnd: string; published: string }> {
  return filledPeriods(statements, shown).filter(({ stamp }) => stamp.label === "published")
    .map(({ periodEnd, stamp }) => ({ periodEnd, published: stamp.date }));
}

/**
 * "From ASX key statistics (read 2026-10-22): 2026-06-30 revenue, net income;
 * 2025-06-30 revenue, net income.": the years a statements table shows that
 * Gloom Cloud filled from the listing's exchange because the statements source
 * does not have them yet, newest first, with the lines taken. A period read
 * from the company's results announcement is dated by its publication ("6
 * months to 2026-06-30 revenue, net income (published 2026-08-20)"), each
 * day said once for the periods it dates. `shown` keeps the lines the table
 * has a row for. Null when no shown line was filled.
 */
export function filledPeriodsNote(
  statements: readonly FilledRow[],
  shown?: ReadonlySet<string>,
): string | null {
  // A TTM Gloom Cloud built from the year and the half since it says how.
  const basis = statements.find(({ aggregation }) => aggregation?.kind === "annual-plus-interim")?.aggregation?.basis;
  const trailing = basis ? `TTM is ${basis}, from the company's results announcements.` : null;
  const filled = filledPeriods(statements, shown);
  if (filled.length === 0) return trailing;
  const sources = [...new Set(filled.map((period) => period.source))];
  let note: string;
  // Each announcement dates its own periods: "TTM revenue; 2025-12-31 revenue (published 2026-03-25)".
  if (filled.every(({ stamp }) => stamp.label === "published")) {
    const days = [...new Set(filled.map(({ stamp }) => stamp.date))];
    const lines = (day: string) => filled.filter(({ stamp }) => stamp.date === day).map(({ period, fields }) => `${period} ${fields.join(", ")}`).join("; ");
    note = `From ${sources.join(" and ")}: ${days.map((day) => `${lines(day)} (published ${day})`).join("; ")}.`;
  } else {
    const read = filled.map(({ stamp }) => stamp.date).sort().at(-1);
    note = `From ${sources.join(" and ")} (read ${read}): ${filled.map(({ period, fields }) => `${period} ${fields.join(", ")}`).join("; ")}.`;
  }
  return trailing ? `${note} ${trailing}` : note;
}

/**
 * A merged row's fill, for the filled lines it still holds as the filled row
 * gave them; a line another source's row supplied is that source's.
 */
function retainedFill(merged: FinancialStatement, rows: Array<FinancialStatement | undefined>): StatementFill | undefined {
  for (const row of rows) {
    const fill = row?.filledFrom;
    if (!fill) continue;
    const filled: readonly ResultsFillField[] = fill.fields;
    const fields = filled.filter((field) => typeof merged[field] === "number" && Object.is(merged[field], row![field]));
    // The lines kept are some of the fill's own, so the fill keeps its kind.
    if (fields.length > 0) return { ...fill, fields } as StatementFill;
  }
  return undefined;
}

/**
 * The months a row's flows cover where its list's usual is another: 6 for a
 * half Gloom Cloud filled into the quarterly list from a results announcement.
 * Undefined for a row of its list's usual length.
 */
export function statementPeriodMonths(row: Pick<FinancialStatement, "filledFrom">): number | undefined {
  return row.filledFrom?.source === "results" ? row.filledFrom.periodMonths : undefined;
}

/** A quarterly list's rows that are quarters: never a filled half, which no four-quarter sum or quarter-on-quarter change may take. */
export function quarterRows<T extends Pick<FinancialStatement, "filledFrom">>(rows: readonly T[]): T[] {
  return rows.filter((row) => (statementPeriodMonths(row) ?? 3) <= 3);
}

export const SEC_EPS_BASIS_NOTICE = "SEC EPS uses corroborated split-adjusted share bases. Unverified bases are unavailable.";

const STATEMENT_METADATA_KEYS = new Set(["date", "dateSource", "accountingStandard", "providerDate", "dateEvidence", "currency", "availableAt", "fieldAvailability", "epsBasis", "fieldSources", "unavailableFields", "withdrawnObservations", "operatingResult", "operatingResultAggregation", "earningsResult", "unavailableEarnings", "filledFrom"]);
const NEARBY_PERIOD_END_MS = 7 * 24 * 60 * 60 * 1_000;

/** An explicit field map is authoritative: omitted fields have unknown availability. */
export function statementFieldAvailability(row: FinancialStatement | undefined, field: string): string | undefined {
  const filed = isIncomeStatementField(field) ? row?.fieldSources?.[field]?.filed : undefined;
  const value = filed ?? (row?.fieldAvailability !== undefined ? row.fieldAvailability?.[field] : row?.availableAt);
  return value && Number.isFinite(Date.parse(value)) ? value : undefined;
}

/** A date without a publication time is only known to be available after that day. */
export function financialAvailabilityTime(value: string): number {
  return Date.parse(value) + (/^\d{4}-\d{2}-\d{2}$/.test(value) ? 86_400_000 : 0);
}

/** A derived value is dated only when every input's availability is known. */
export function completeAvailability(values: readonly (string | null | undefined)[]): string | undefined {
  if (values.length === 0 || values.some((value) => !value || !Number.isFinite(Date.parse(value)))) return undefined;
  return values.reduce<string | undefined>((latest, value) => (
    !latest || financialAvailabilityTime(value!) > financialAvailabilityTime(latest) ? value! : latest
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
