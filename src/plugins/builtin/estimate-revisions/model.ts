import type {
  EstimateObservation,
  EstimatePeriod,
  EstimateRevisionsPayload,
} from "../../../api-client/estimate-revisions";
import type { DataTableColumn } from "../../../components";
export const estimateNumber = (value: number | null | undefined) =>
  value == null
    ? "--"
    : value.toLocaleString("en-US", { maximumFractionDigits: 4 });
export const estimatePercent = (value: number | null | undefined) =>
  value == null ? "--" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
export const estimateCurrent = (period: EstimatePeriod) =>
  period.current ?? period.recorded.at(-1) ?? null;
export const periodLabel = (period: EstimatePeriod) =>
  `${period.frequency === "annual" ? "FY" : "Q"} ${period.periodEnd}`;
export const periodRank = (period: EstimatePeriod) =>
  `${period.percentile.percentile == null ? "--" : period.percentile.percentile.toFixed(0)} pctl / ${period.percentile.samples} obs`;
export function revisionNotices(data: EstimateRevisionsPayload) {
  return [
    ...Object.entries(data.sources).flatMap(([source, state]) =>
      state.status !== "available"
        ? [`${source}: ${state.reason ?? "source unavailable"}`]
        : [],
    ),
    ...(data.historyCoverage.recordedDays < 20
      ? [
          "Fewer than 20 actual observation days; EPS percentiles remain unavailable.",
        ]
      : []),
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
export const PERIOD_COLUMNS: DataTableColumn[] = [
  { id: "period", label: "FISCAL END", width: 16, align: "left" },
  { id: "currency", label: "CCY", width: 5, align: "left" },
  { id: "eps", label: "EPS", width: 11, align: "right" },
  { id: "percentile", label: "PCTL 1Y", width: 9, align: "right" },
  { id: "change", label: "CHANGE %", width: 11, align: "right" },
  { id: "breadth", label: "UP/DN 30D", width: 12, align: "right" },
  { id: "range", label: "HI-LO", width: 11, align: "right" },
  { id: "asOf", label: "AS OF", width: 12, align: "left", flexGrow: 1 },
];
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

export function pinnedEstimatePeriods(
  periods: EstimatePeriod[],
  periodEnd: unknown,
  frequency: unknown = "quarterly",
): EstimatePeriod[] {
  if (periodEnd == null || periodEnd === "") return periods;
  if (
    typeof periodEnd !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd) ||
    !Number.isFinite(Date.parse(periodEnd)) ||
    new Date(periodEnd).toISOString().slice(0, 10) !== periodEnd
  ) {
    throw new Error("Fiscal end must be a valid YYYY-MM-DD date.");
  }
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
