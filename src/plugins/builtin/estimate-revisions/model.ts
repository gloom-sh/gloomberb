import { MISSING_VALUE } from "../../../utils/format";
import { formatFilingDate } from "../../../utils/datetime-format";
import type {
  EstimateObservation,
  EstimatePeriod,
  EstimateRevisionsPayload,
  EstimateSurprise,
} from "../../../api-client/estimate-revisions";
import type { DataTableColumn } from "../../../components";
import { dateOptionError, readCalendarDate } from "../../../utils/calendar-date";
import { epsSurprise, type Surprise } from "../shared/earnings-report";
export const NO_ESTIMATE_PERIODS_TITLE = "No covered estimate periods.";
/** An EPS figure, consensus or reported, to the cent: 8.84 beside 1.99, never 8.8384. */
export const estimateEps = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value)
    ? MISSING_VALUE
    : value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** A count (analysts, revisions up or down). */
export const estimateCount = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value) ? MISSING_VALUE : Math.round(value).toLocaleString("en-US");
/** A percentile rank, whole: 99, never 98.9362. */
export const estimatePercentile = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value) ? MISSING_VALUE : value.toFixed(0);
export const estimatePercent = (value: number | null | undefined) =>
  value == null ? MISSING_VALUE : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
export const estimateCurrent = (period: EstimatePeriod) =>
  period.current ?? period.recorded.at(-1) ?? null;
export const periodLabel = (period: EstimatePeriod) =>
  `${period.frequency === "annual" ? "FY" : "Q"} ${period.periodEnd}`;
/**
 * A calendar day as every pane writes one, day first ("02 Nov 2026"); the
 * value itself when it is no date. Exports keep the ISO day.
 */
export const estimateDay = (value: string | null | undefined) => value ? formatFilingDate(value, value) : MISSING_VALUE;
/** A period as the pane names it, its fiscal end day first: "Q 31 Dec 2026". */
export const periodTitle = (period: EstimatePeriod) =>
  `${period.frequency === "annual" ? "FY" : "Q"} ${estimateDay(period.periodEnd)}`;
export function revisionNotices(data: EstimateRevisionsPayload) {
  return [
    ...Object.entries(data.sources).flatMap(([source, state]) =>
      state.status !== "available"
        ? [`${source}: ${state.reason ?? "source unavailable"}`]
        : [],
    ),
    ...(data.historyCoverage.truncated
      ? ["Stored history is truncated to the latest 4,000 rows."]
      : []),
    ...(data.historyCoverage.excludedRows
      ? ["Some stored rows lack a valid fiscal identity or observation date."]
      : []),
  ];
}
export function estimateHistory(period: EstimatePeriod) {
  return [...period.recorded, ...period.lookbacks].toSorted(
    (a, b) => b.date.localeCompare(a.date) || a.source.localeCompare(b.source),
  );
}
export function estimatePoints(rows: EstimateObservation[]) {
  return rows.map((row) => ({
    date: new Date(row.date),
    observedAt: new Date(row.recordedAt ?? row.date),
    value: row.average,
  }));
}
/** The one currency every period is in, to head the EPS column with; null when they differ or one is unstated. */
export function sharedPeriodCurrency(periods: readonly EstimatePeriod[]): string | null {
  const first = periods[0]?.currency ?? null;
  return first && periods.every((period) => period.currency === first) ? first : null;
}

/**
 * The Revisions table's columns: the quarters and years sit in sections of
 * their own, so FISCAL END is the date alone. One currency for every period
 * heads EPS (EPS USD); periods in several keep a CCY column.
 */
export function periodColumns(currency: string | null): DataTableColumn[] {
  return [
    { id: "period", label: "FISCAL END", width: 11, align: "left" },
    ...(currency ? [] : [{ id: "currency", label: "CCY", width: 5, align: "left" as const }]),
    { id: "eps", label: currency ? `EPS ${currency}` : "EPS", width: 9, align: "right" },
    { id: "percentile", label: "PCTL 1Y", width: 8, align: "right", title: "Where the consensus sits in its range over the last year, 0 to 100" },
    { id: "change", label: "CHANGE %", width: 9, align: "right" },
    { id: "breadth", label: "UP/DN 30D", width: 10, align: "right", title: "Estimates revised up and down in the last 30 days" },
    { id: "range", label: "HI-LO", width: 7, align: "right", omitWhenEmpty: true, title: "Highest estimate less the lowest" },
    // One day for every period is the figures' (EPS's detail), and the column goes.
    { id: "asOf", label: "AS OF", width: 11, align: "left", flexGrow: 1, omitWhenSame: true },
  ];
}

/** The actual less the estimate, as served, else from the two; none without both. */
export function estimateDifference(row: Pick<EstimateSurprise, "actual" | "estimate" | "difference">): number | null {
  if (row.difference != null && Number.isFinite(row.difference)) return row.difference;
  return row.actual != null && row.estimate != null ? row.actual - row.estimate : null;
}

/**
 * A report's EPS surprise as Surprises shows and sorts it: the actual over the
 * estimate, as EVT and ERN work it out (N/M against a loss or zero estimate),
 * else the percent the source gives.
 */
export function estimateSurprise(row: Pick<EstimateSurprise, "actual" | "estimate" | "percent">): Surprise {
  const surprise = epsSurprise(row.actual, row.estimate);
  if (surprise != null) return surprise;
  return row.percent == null ? null : row.percent / 100;
}

export function sortPeriods(
  periods: EstimatePeriod[],
  column: string,
  direction: "asc" | "desc",
) {
  const value = (period: EstimatePeriod): string | number | null =>
    column === "period"
      ? period.periodEnd
      : column === "currency"
        ? period.currency
        : column === "eps"
          ? (estimateCurrent(period)?.average ?? null)
          : column === "change"
            ? period.change.percent
            : column === "percentile"
              ? period.percentile.percentile
              : column === "range"
                ? (estimateCurrent(period)?.range ?? null)
                : column === "breadth"
                  ? (period.breadth.find((row) => row.days === 30)?.net ?? null)
                  : (estimateCurrent(period)?.date ?? null);
  return [...periods].sort((a, b) => {
    const left = value(a),
      right = value(b);
    if (left == null || right == null)
      return left == null ? (right == null ? 0 : 1) : -1;
    return (
      (left < right ? -1 : left > right ? 1 : 0) *
        (direction === "asc" ? 1 : -1) || a.id.localeCompare(b.id)
    );
  });
}

/** The periods ending on a fiscal end date, as a date option reads one; `option` is how a command line types it (`--period`). */
export function pinnedEstimatePeriods(
  periods: EstimatePeriod[],
  requestedEnd: unknown,
  frequency: unknown = "quarterly",
  option = "",
): EstimatePeriod[] {
  if (requestedEnd == null || requestedEnd === "") return periods;
  const text = typeof requestedEnd === "string" ? requestedEnd.trim() : String(requestedEnd);
  const periodEnd = readCalendarDate(text);
  if (!periodEnd) throw new Error(dateOptionError(text, option, { subject: "a fiscal end date" }));
  if (frequency !== "quarterly" && frequency !== "annual")
    throw new Error("Frequency must be quarterly or annual.");
  const matches = periods.filter(
    (period) =>
      period.periodEnd === periodEnd && period.frequency === frequency,
  );
  if (!matches.length)
    throw new Error(`No ${frequency} estimates for fiscal end ${periodEnd}.`);
  return matches;
}
