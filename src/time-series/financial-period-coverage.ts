import type { ChartSeriesSpec, ChartSpec, ResolvedSeries, TimeSeriesPoint } from "./types";

function isFinancialSeries(series: ChartSeriesSpec | undefined): boolean {
  return series?.source.kind === "security" && /^(fundamental|valuation)\./.test(series.source.fieldId);
}

/** Current multiples are snapshots, not annual/quarterly financial observations. */
function isUsableFinancialObservation(point: TimeSeriesPoint): boolean {
  return point.periodLabel !== "Current" && point.value != null && Number.isFinite(point.value);
}

export function limitSeriesObservations(spec: ChartSpec, series: ResolvedSeries): ResolvedSeries {
  if (spec.viewport.maxPoints === undefined) return series;
  const definition = spec.series.find((entry) => entry.id === series.id);
  if (!isFinancialSeries(definition)) {
    return { ...series, points: series.points.slice(-spec.viewport.maxPoints) };
  }
  const points = series.points.filter((point) => point.periodLabel !== "Current");
  let remaining = spec.viewport.maxPoints;
  let start = points.length;
  for (let index = points.length - 1; index >= 0; index--) {
    if (!isUsableFinancialObservation(points[index]!)) continue;
    start = index;
    if (--remaining <= 0) break;
  }
  // Count usable observations, but retain missing periods within the selected
  // history and at its end so charts cannot draw through absent financial data.
  return { ...series, points: points.slice(start) };
}

export interface FinancialPeriodCoverage {
  seriesId: string;
  label: string;
  period: string;
  requested: number;
  returned: number;
  complete: boolean;
}

export function financialPeriodCoverage(spec: ChartSpec, series: readonly ResolvedSeries[]): FinancialPeriodCoverage[] {
  const requested = spec.viewport.maxPoints;
  if (requested === undefined) return [];
  return spec.series.filter((entry) => entry.visible !== false && isFinancialSeries(entry)).map((definition) => {
    const resolved = series.find((entry) => entry.id === definition.id);
    const returned = resolved?.points.filter(isUsableFinancialObservation).length ?? 0;
    const period = definition.source.kind === "security" && definition.source.period && definition.source.period !== "auto"
      ? definition.source.period : resolved?.nativeFrequency ?? "financial";
    return { seriesId: definition.id, label: resolved?.label ?? definition.label ?? definition.id,
      period, requested, returned, complete: returned >= requested };
  });
}

export function financialPeriodCoverageWarnings(coverage: readonly FinancialPeriodCoverage[]): string[] {
  return coverage.filter((entry) => !entry.complete).map((entry) => (
    `${entry.label}: ${entry.returned} of ${entry.requested} requested ${entry.period} observations available in this window.`
  ));
}
