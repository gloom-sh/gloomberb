import type { KpiPeriod } from "../../../api-client/company-kpis";

const DAY_MS = 86_400_000;
/**
 * A series whose latest figure ended this long before the company's newest
 * figure of its kind (a year's, or a quarter's, half's, year to date's or
 * date's) is one the company no longer reports: nine months, so a year stays
 * until the next one and a quarter until the third one after it.
 */
const NO_LONGER_REPORTED_DAYS = 270;

type Kind = "year" | "interim";
const kindOf = (period: Pick<KpiPeriod, "kind">): Kind => (period.kind === "year" ? "year" : "interim");
const endOf = (period: Pick<KpiPeriod, "end">): number => (period.end ? Date.parse(period.end) : Number.NaN);

/**
 * The series whose latest figure is still the company's: Latest KPIs lists
 * these, KPI history every one. HSBC's series of diluted quarterly EPS ended
 * with Q1 FY2024, two years before its newest quarter, and Latest listed that
 * EPS beside FY2025's; AIA's FY2024 segment figures stood beside its FY2025
 * ones, and Xiaomi's third quarter of 2025 beside its second of 2026. A
 * series is left out once its latest figure ended NO_LONGER_REPORTED_DAYS or
 * more before the newest figure of its kind among all the company's series (a
 * quarter's, half's or date's, before the newest of either kind). A figure
 * with no end date stays.
 */
export function currentKpiSeries<T extends { latest: { period: Pick<KpiPeriod, "kind" | "end"> } }>(series: readonly T[]): T[] {
  const newest = new Map<Kind, number>();
  for (const { latest } of series) {
    const end = endOf(latest.period);
    const kind = kindOf(latest.period);
    if (Number.isFinite(end) && end > (newest.get(kind) ?? Number.NEGATIVE_INFINITY)) newest.set(kind, end);
  }
  // A year stands until the next year; a quarter, half or date is measured against the newest figure of any kind,
  // so one long older than the company's latest year is no current quarter either.
  const reference = (kind: Kind) => kind === "year"
    ? newest.get("year")
    : Math.max(newest.get("interim") ?? Number.NEGATIVE_INFINITY, newest.get("year") ?? Number.NEGATIVE_INFINITY);
  return series.filter(({ latest }) => {
    const end = endOf(latest.period);
    const latestOfKind = reference(kindOf(latest.period));
    return !Number.isFinite(end) || latestOfKind === undefined || !Number.isFinite(latestOfKind)
      || (latestOfKind - end) / DAY_MS < NO_LONGER_REPORTED_DAYS;
  });
}
