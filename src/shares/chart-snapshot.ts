import type { ResolvedSeries } from "../time-series/types";
import type { ChartShareData } from "./payload";
import { effectiveTimeSeriesPointTime } from "../time-series/alignment";

type SharedPoint = ChartShareData["series"][number]["points"][number];
const MAX_POINTS = 500;
const MAX_TOTAL_POINTS = 1_000;

// Sample finite extrema first, reserving enough space to restore original gaps.
// Every omitted interval containing a null stays broken, even with dense gaps.
function sample(values: SharedPoint[], limit: number): SharedPoint[] {
  if (values.length <= limit) return values;
  const finiteIndices = values.flatMap((point, index) => point.y === null ? [] : [index]);
  if (finiteIndices.length !== values.length) {
    if (!finiteIndices.length) return [values[0]!, values.at(-1)!];
    // At most N finite points, N-1 intervening gaps and two boundary gaps.
    const finiteLimit = Math.floor((limit - 1) / 2);
    const selected = sample(finiteIndices.map((index) => ({ x: index, y: values[index]!.y })), finiteLimit);
    const result: SharedPoint[] = [];
    let previous = -1;
    for (const selectedPoint of selected) {
      const index = Number(selectedPoint.x);
      for (let cursor = previous + 1; cursor < index; cursor++) {
        if (values[cursor]!.y === null) { result.push(values[cursor]!); break; }
      }
      result.push(values[index]!);
      previous = index;
    }
    if (values.at(-1)!.y === null) result.push(values.at(-1)!);
    return result;
  }
  const buckets = Math.floor((limit - 2) / 2);
  const result = [values[0]!];
  for (let bucket = 0; bucket < buckets; bucket++) {
    const start = 1 + Math.floor(bucket * (values.length - 2) / buckets);
    const end = 1 + Math.floor((bucket + 1) * (values.length - 2) / buckets);
    const entries = values.slice(start, end);
    let low = 0;
    let high = 0;
    entries.forEach((point, index) => {
      if (point.y! < entries[low]!.y!) low = index;
      if (point.y! > entries[high]!.y!) high = index;
    });
    for (const index of [...new Set([low, high])].sort((a, b) => a - b)) result.push(entries[index]!);
  }
  result.push(values.at(-1)!);
  return result;
}

export function buildChartShareData(
  series: ResolvedSeries[],
  viewport?: { start: Date; end: Date } | null,
  warnings: readonly string[] = [],
): ChartShareData | null {
  const visible = series.filter((entry) => !entry.hidden).slice(0, 20);
  const hasMarketTimeline = series.some((entry) => entry.timeBasis?.kind === "market");
  const limit = Math.min(MAX_POINTS, Math.floor(MAX_TOTAL_POINTS / Math.max(1, visible.length)));
  const notes = [...warnings];
  if (series.filter((entry) => !entry.hidden).length > 20) notes.push("Only the first 20 visible series are included.");
  const window = viewport && Number.isFinite(viewport.start.getTime()) && Number.isFinite(viewport.end.getTime())
    && viewport.start <= viewport.end ? viewport : null;
  const sharedSeries = visible.flatMap((entry) => {
    if (entry.warning) notes.push(`${entry.label}: ${entry.warning}`);
    const step = entry.style === "step" || entry.interpolation === "step-after";
    const useAvailability = hasMarketTimeline && !entry.timeBasis;
    if (useAvailability && entry.points.some((point) => effectiveTimeSeriesPointTime(point) !== point.date.getTime())) {
      notes.push(`${entry.label}: dates use known availability on the market chart; underlying fiscal period dates are not included in this snapshot.`);
    }
    const observations = entry.points.map((point) => useAvailability
      ? { ...point, date: new Date(effectiveTimeSeriesPointTime(point)) } : point)
      .filter((point) => Number.isFinite(point.date.getTime()))
      .sort((a, b) => a.date.getTime() - b.date.getTime());
    const anchor = step && window && !observations.some((point) => point.date.getTime() === window.start.getTime())
      ? observations.findLast((point) => point.date < window.start) : undefined;
    const points = observations.flatMap((point): SharedPoint[] => {
      const time = point.date.getTime();
      if (point !== anchor && window && (time < window.start.getTime() || time > window.end.getTime())) return [];
      return [{ x: point.date.toISOString(), y: Number.isFinite(point.value) ? point.value : null }];
    });
    if (points.length === 0) {
      notes.push(`${entry.label}: no observations in the shared window.`);
      if (!window) return [];
      points.push({ x: window.start.toISOString(), y: null });
    }
    if (points.length > limit) notes.push(`${entry.label}: sampled for sharing; some observations are omitted and missing intervals may appear wider.`);
    if (entry.dataShape === "ohlcv") notes.push(`${entry.label}: closing values; OHLC bars are not included in this snapshot.`);
    if (step) notes.push(`${entry.label}: step levels are held between observations; the preceding observation is retained when needed to explain the window's opening level.`);
    const style: "line" | "step" | "points" = entry.style === "columns" || entry.style === "points" ? "points"
      : entry.style === "step" || entry.interpolation === "step-after" ? "step" : "line";
    if (entry.style === "columns") notes.push(`${entry.label}: column observations shown as points.`);
    return [{ style, name: entry.label.slice(0, 120), ...(entry.unit ? { unit: entry.unit.slice(0, 80) } : {}), points: sample(points, limit) }];
  });
  if (!sharedSeries.some((entry) => entry.points.some((point) => point.y !== null))) return null;
  const title = sharedSeries.map((entry) => entry.name).join(" / ");
  const uniqueNotes = [...new Set(notes.filter(Boolean))];
  return {
    title: title.length <= 200 ? title : `Chart comparison (${sharedSeries.length} series)`,
    series: sharedSeries,
    ...(window ? { viewport: { start: window.start.toISOString(), end: window.end.toISOString() } } : {}),
    ...(uniqueNotes.length ? { warnings: uniqueNotes.slice(0, uniqueNotes.length > 20 ? 19 : 20).map((note) => note.slice(0, 500))
      .concat(uniqueNotes.length > 20 ? [`${uniqueNotes.length - 19} additional data warnings; inspect the source chart.`] : []) } : {}),
  };
}
