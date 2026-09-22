import type { StaticChartOverlay } from "../../../components/chart/static/chart-surface";
import type { ProjectedChartPoint } from "../../../components/chart/core/data";

const DAY_MS = 86_400_000;

export interface VolatilityCurveDatum {
  tenor: string;
  days: number;
  value: number | null;
}

export interface VolatilityHistoryDatum {
  date: string;
  value: number | null;
}

interface FredChartInput {
  metrics: readonly { seriesId: string; history: readonly VolatilityHistoryDatum[]; missingDates?: readonly string[] }[];
  ratioHistory: readonly VolatilityHistoryDatum[];
}

function chartPoint(date: Date, value: number | null | undefined): ProjectedChartPoint {
  // StaticChartSurface normalizes nonfinite values to explicit line breaks.
  const close = value != null && Number.isFinite(value) ? value : Number.NaN;
  return { date, open: close, high: close, low: close, close, volume: 0 };
}

export function volatilityCurveChartModel(curve: readonly VolatilityCurveDatum[]) {
  const ordered = curve.toSorted((left, right) => left.days - right.days);
  const first = ordered[0]?.days ?? 9, last = ordered.at(-1)?.days ?? 365;
  const span = Math.max(1, last - first);
  return {
    points: ordered.map((point) => chartPoint(new Date(point.days * DAY_MS), point.value)),
    ticks: ordered.map((point) => ({ label: point.tenor, ratio: (point.days - first) / span })),
    formatCursor: (ratio: number) => `${Math.round(first + Math.max(0, Math.min(1, ratio)) * span)} days`,
  };
}

function observationMap(history: readonly VolatilityHistoryDatum[], missingDates: readonly string[] = []) {
  const validDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date));
  const points = new Map(history.filter((point) => validDate(point.date)).map((point) => [point.date, point.value]));
  for (const date of missingDates) if (validDate(date)) points.set(date, null);
  return points;
}

/** Overlay values are split into runs because the shared overlay adapter omits nulls. */
function lineRuns(id: string, color: string, values: readonly (number | null | undefined)[]): StaticChartOverlay[] {
  const runs: StaticChartOverlay[] = [];
  let points: Array<{ index: number; value: number }> = [];
  const flush = () => {
    if (points.length) runs.push({ id: `${id}-${runs.length}`, color,
      style: points.length === 1 ? "points" : "line", points });
    points = [];
  };
  values.forEach((value, index) => {
    if (value == null || !Number.isFinite(value)) flush();
    else points.push({ index, value });
  });
  flush();
  return runs;
}

function fredTimeline(fred: FredChartInput) {
  const spotMetric = fred.metrics.find((metric) => metric.seriesId === "VIXCLS");
  const threeMonthMetric = fred.metrics.find((metric) => metric.seriesId === "VXVCLS");
  const spot = observationMap(spotMetric?.history ?? [], spotMetric?.missingDates);
  const threeMonth = observationMap(threeMonthMetric?.history ?? [], threeMonthMetric?.missingDates);
  const dates = [...new Set([...spot.keys(), ...threeMonth.keys()])].sort();
  return { spot, threeMonth, dates };
}

export function volatilityHistoryChartModel(fred: FredChartInput, threeMonthColor: string) {
  const { spot, threeMonth, dates } = fredTimeline(fred);
  return {
    points: dates.map((date) => chartPoint(new Date(date), spot.get(date))),
    overlays: lineRuns("VIX 3M", threeMonthColor, dates.map((date) => threeMonth.get(date))),
  };
}

export function volatilityRatioChartModel(fred: FredChartInput, referenceColor: string) {
  const { dates } = fredTimeline(fred);
  const ratios = observationMap(fred.ratioHistory);
  return {
    points: dates.map((date) => chartPoint(new Date(date), ratios.get(date))),
    overlays: dates.length ? [{ id: "1.00", color: referenceColor,
      points: [{ index: 0, value: 1 }, ...(dates.length > 1 ? [{ index: dates.length - 1, value: 1 }] : [])],
    } satisfies StaticChartOverlay] : [],
  };
}

export function volatilityIndexHistoryPoints(history: readonly VolatilityHistoryDatum[], missingDates: readonly string[] = []): ProjectedChartPoint[] {
  return [...observationMap(history, missingDates)].sort(([left], [right]) => left.localeCompare(right))
    .map(([date, value]) => chartPoint(new Date(date), value));
}
