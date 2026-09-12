import type { ProjectedChartPoint } from "../../../components/chart/core/data";
import type { YieldPoint } from "./treasury-data";

const YEAR_MS = 365 * 86_400_000;

/** Encode maturity in the chart's continuous coordinate space, never as calendar labels. */
export function buildYieldCurveChart(points: readonly YieldPoint[], width: number) {
  const available = points.filter((point) => point.yield != null && Number.isFinite(point.yield)
    && Number.isFinite(point.maturityYears) && point.maturityYears > 0)
    .toSorted((a, b) => a.maturityYears - b.maturityYears);
  const first = available[0];
  const last = available.at(-1);
  const min = first?.maturityYears ?? 0;
  const span = (last?.maturityYears ?? min) - min;
  const ratio = (years: number) => span > 0 ? (years - min) / span : 0;
  const ticks = first && last && first !== last
    ? [{ label: first.maturity, ratio: 0 }, { label: last.maturity, ratio: 1 }]
    : [];
  // Keep the short end dense in the data without piling up overlapping labels.
  for (const years of [10, 20, 5, 2, 1]) {
    const x = ratio(years);
    if (x <= 0 || x >= 1 || ticks.some((tick) => Math.abs(tick.ratio - x) * Math.max(1, width - 1) < 6)) continue;
    ticks.push({ label: `${years}Y`, ratio: x });
  }
  const chartPoints: ProjectedChartPoint[] = available.map((point) => ({
    date: new Date(point.maturityYears * YEAR_MS),
    open: point.yield!, high: point.yield!, low: point.yield!, close: point.yield!, volume: 0,
  }));
  return {
    points: chartPoints,
    ticks: ticks.toSorted((a, b) => a.ratio - b.ratio),
    formatCursor: (x: number) => {
      const years = min + Math.max(0, Math.min(1, x)) * span;
      return years < 1 ? `${(years * 12).toFixed(1)}M` : `${years.toFixed(1)}Y`;
    },
  };
}
