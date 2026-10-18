import { pricePointsToResolvedSeries } from "../../../components/chart/composite/price-series";
import { staticSeries } from "../../../components/chart/static/series";
import type { ResolvedSeries } from "../../../time-series/types";
import type { PricePoint } from "../../../types/financials";
import type { RollingRealizedVolatilityPoint, VolatilityConeStatistics } from "../shared/volatility";

interface IvChartReference { value: number; date: Date; label: string }
export interface RealizedChartInput {
  history: readonly PricePoint[];
  rolling: readonly RollingRealizedVolatilityPoint[];
  windows: readonly number[];
  /** What the price panel reads in: the quote's currency, or points for an index (`priceSeriesUnit`). */
  priceUnit: string;
  iv: IvChartReference | null;
}

export function realizedChartSeries(input: RealizedChartInput, colors: readonly string[], priceColor = colors[0]!): ResolvedSeries[] {
  const series = input.windows.map((window, index): ResolvedSeries => ({
    ...staticSeries(input.rolling.map((point) => ({ date: point.date, observedAt: point.date,
      value: point.values[window] == null ? null : point.values[window]! * 100 })),
    { id: `hv-${window}`, label: `HV${window}`, color: colors[index % colors.length]! }),
    unit: "%", unitGroup: "volatility", panelId: "vol", observationKind: "market",
  }));
  if (input.iv && Number.isFinite(input.iv.date.getTime())) {
    // One dated observation. Extending it back over price history would invent IV history.
    series.push({ ...staticSeries([{ date: input.iv.date, observedAt: input.iv.date, value: input.iv.value * 100 }],
      { id: "current-iv", label: input.iv.label, color: colors.at(-1)!, style: "points" }),
    unit: "%", unitGroup: "volatility", panelId: "vol", observationKind: "market" });
  }
  series.push(pricePointsToResolvedSeries(input.history, {
    id: "price", label: "Price", unit: input.priceUnit, color: priceColor, panelId: "price", style: "line",
    timeBasis: { kind: "market", timeZone: "UTC", cadenceMs: 86_400_000 },
  }));
  return series;
}

const SESSION_MS = 86_400_000;
/** The cone's x coordinate for a session window: a numeric position stored as a time, not a market date. */
export const coneWindowDate = (window: number) => new Date(window * SESSION_MS);
/** Room kept beyond the first and last window, as a fraction of the span between them. */
const CONE_DOMAIN_PADDING = 0.04;

/**
 * The cone's x axis in session windows. It runs a little past the first and
 * last window, so a marker or the end of a line on either is drawn whole and
 * not cut by the plot's edge; ticks and the cursor read through the same range.
 */
export function coneDomain(rows: readonly Pick<VolatilityConeStatistics, "window">[]) {
  const windows = rows.map((row) => row.window).filter(Number.isFinite);
  const first = windows.length ? Math.min(...windows) : 10, last = windows.length ? Math.max(...windows) : 260;
  const padding = Math.max(1, last - first) * CONE_DOMAIN_PADDING;
  const start = first - padding, end = last + padding;
  return {
    first, last, start, end,
    viewport: { start: coneWindowDate(start), end: coneWindowDate(end) },
    ratio: (window: number) => (window - start) / (end - start),
    window: (ratio: number) => Math.round(start + ratio * (end - start)),
  };
}

export function coneChartSeries(rows: readonly VolatilityConeStatistics[], colors: readonly string[]): ResolvedSeries[] {
  return (["min", "max", "mean", "current"] as const).map((field, index) => ({
    ...staticSeries(rows.map((row) => {
      const date = coneWindowDate(row.window);
      return { date, observedAt: date, value: row[field] == null ? null : row[field]! * 100 };
    }), { id: field, label: field === "current" ? "Current" : field === "mean" ? "Mean" : field === "min" ? "Min" : "Max",
      color: colors[index]!, calendarSpaced: true }),
    unit: "%", unitGroup: "volatility",
  }));
}
