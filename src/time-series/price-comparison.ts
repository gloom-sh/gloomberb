import { scalarPointValue } from "./alignment";
import { getTimeSeriesField } from "./field-catalog";
import type { ChartSpec, ResolvedSeries } from "./types";

export const PRICE_COMPARISON_BASIS = "Price returns in each listing's currency; cash distributions and FX conversion excluded.";

export interface PriceComparison {
  seriesIds: string[];
  /** Exact source observation timestamps, never filled or rounded across markets. */
  start: number | null;
  end: number | null;
  notice: string;
}

function displayDate(time: number): string {
  const iso = new Date(time).toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.replace("T", " ").replace(".000Z", " UTC");
}

/** Comparable normalized closing-price legs share observed endpoints. Other chart meanings are unchanged. */
export function priceComparisonSeriesIds(spec: ChartSpec): string[] | null {
  if (spec.viewport.maxPoints !== undefined) return null;
  const visible = spec.series.filter((entry) => entry.visible !== false);
  if (visible.length < 2 || !visible.every((entry) => {
    const field = entry.source.kind === "security" ? getTimeSeriesField(entry.source.fieldId)?.id : null;
    return (field === "market.close" || field === "market.ohlcv")
      && (entry.transform === "percent" || entry.transform === "index100")
      && entry.transform === visible[0]!.transform
      && entry.panelId === visible[0]!.panelId
      && entry.source.kind === "security" && visible[0]!.source.kind === "security"
      && (entry.source.period ?? "auto") === (visible[0]!.source.period ?? "auto");
  })) return null;
  return visible.map((entry) => entry.id);
}

export function resolvePriceComparison(
  spec: ChartSpec,
  series: readonly ResolvedSeries[],
  bounds: { start: number | null; end: number | null },
): PriceComparison | null {
  const seriesIds = priceComparisonSeriesIds(spec);
  if (!seriesIds) return null;
  const byId = new Map(series.map((entry) => [entry.id, entry]));
  const timestamps = seriesIds.map((id) => new Set((byId.get(id)?.points ?? []).flatMap((point) => {
    const time = point.date.getTime();
    const value = scalarPointValue(point);
    return Number.isFinite(time) && value !== null
      && (bounds.start === null || time >= bounds.start)
      && (bounds.end === null || time <= bounds.end) ? [time] : [];
  })));
  const shared = [...timestamps[0]!].filter((time) => timestamps.every((times) => times.has(time))).sort((a, b) => a - b);
  const start = shared.find((time) => seriesIds.every((id) => {
    const point = byId.get(id)?.points.find((point) => point.date.getTime() === time);
    return point && scalarPointValue(point) !== 0;
  }));
  const end = shared.at(-1);
  if (start === undefined || end === undefined || start >= end) return {
    seriesIds, start: null, end: null,
    notice: `${PRICE_COMPARISON_BASIS} Comparison unavailable: need two shared dates and a nonzero baseline.`,
  };
  return {
    seriesIds, start, end,
    notice: `${PRICE_COMPARISON_BASIS} Shared observations: ${displayDate(start)} to ${displayDate(end)}.`,
  };
}

/** Clip only compared legs; raw observations and study inputs stay available in the source cache. */
export function clipPriceComparison(series: ResolvedSeries, comparison: PriceComparison | null): ResolvedSeries {
  if (!comparison?.seriesIds.includes(series.id)) return series;
  const { start, end } = comparison;
  return {
    ...series,
    // The legend must describe the compared endpoint, not a newer one-leg quote.
    latestChangePercent: undefined,
    points: start === null || end === null ? [] : series.points.filter((point) => (
      point.date.getTime() >= start && point.date.getTime() <= end
    )),
  };
}
