import { pricePointsToResolvedSeries } from "../../../components/chart/composite/price-series";
import { staticSeries } from "../../../components/chart/static/series";
import type { ResolvedSeries } from "../../../time-series/types";
import type { PricePoint } from "../../../types/financials";
import type { RollingRealizedVolatilityPoint, VolatilityConeStatistics } from "../shared/volatility";

export interface IvChartReference { value: number; date: Date; label: string }
export interface RealizedChartInput {
  history: readonly PricePoint[];
  rolling: readonly RollingRealizedVolatilityPoint[];
  windows: readonly number[];
  currency: string;
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
    id: "price", label: "Price", unit: input.currency, color: priceColor, panelId: "price", style: "line",
    timeBasis: { kind: "market", timeZone: "UTC", cadenceMs: 86_400_000 },
  }));
  return series;
}

export function coneChartSeries(rows: readonly VolatilityConeStatistics[], colors: readonly string[]): ResolvedSeries[] {
  return (["min", "max", "mean", "current"] as const).map((field, index) => ({
    ...staticSeries(rows.map((row) => {
      // The synthetic timestamp is a numeric session-window coordinate, not a market date.
      const date = new Date(row.window * 86_400_000);
      return { date, observedAt: date, value: row[field] == null ? null : row[field]! * 100 };
    }), { id: field, label: field === "current" ? "Current" : field === "mean" ? "Mean" : field === "min" ? "Min" : "Max",
      color: colors[index]!, style: field === "current" ? "points" : "line", calendarSpaced: true }),
    unit: "%", unitGroup: "volatility",
  }));
}
