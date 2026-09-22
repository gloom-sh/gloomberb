import type { BacktestResult } from "./engine";

export type StatValue = { value: number | null; kind: "signed" | "percent" | "ratio" | "count" };
export interface SummaryRow {
  id: string;
  label: string;
  strategy: (result: BacktestResult) => StatValue | null;
  benchmark?: (result: BacktestResult) => StatValue | null;
}
const stat = (value: number | null, kind: StatValue["kind"]): StatValue => ({ value, kind });

/** Strategy beside buy-and-hold wherever the comparison is defined. */
export const SUMMARY_ROWS: SummaryRow[] = [
  { id: "total", label: "Total return", strategy: (r) => stat(r.strategy.totalReturnPct, "signed"), benchmark: (r) => stat(r.benchmark.totalReturnPct, "signed") },
  { id: "cagr", label: "CAGR", strategy: (r) => stat(r.strategy.cagrPct, "signed"), benchmark: (r) => stat(r.benchmark.cagrPct, "signed") },
  { id: "vol", label: "Volatility (ann.)", strategy: (r) => stat(r.strategy.volatilityPct, "percent"), benchmark: (r) => stat(r.benchmark.volatilityPct, "percent") },
  { id: "sharpe", label: "Sharpe (0% cash)", strategy: (r) => stat(r.strategy.sharpe, "ratio"), benchmark: (r) => stat(r.benchmark.sharpe, "ratio") },
  { id: "drawdown", label: "Max drawdown", strategy: (r) => stat(r.strategy.maxDrawdownPct, "signed"), benchmark: (r) => stat(r.benchmark.maxDrawdownPct, "signed") },
  { id: "exposure", label: "Time in market", strategy: (r) => stat(r.strategy.exposurePct, "percent"), benchmark: () => stat(100, "percent") },
  { id: "rolling", label: "1Y windows beating B&H", strategy: (r) => stat(r.rollingWin.sharePct, "percent") },
  { id: "trades", label: "Closed trades", strategy: (r) => stat(r.strategy.closedTrades, "count") },
  { id: "hit", label: "Hit rate", strategy: (r) => stat(r.strategy.hitRatePct, "percent") },
  { id: "win", label: "Average win", strategy: (r) => stat(r.strategy.avgWinPct, "signed") },
  { id: "loss", label: "Average loss", strategy: (r) => stat(r.strategy.avgLossPct, "signed") },
  { id: "pf", label: "Profit factor", strategy: (r) => stat(r.strategy.profitFactor, "ratio") },
  { id: "hold", label: "Average hold (sessions)", strategy: (r) => stat(r.strategy.avgSessions, "count") },
];

export function formatStat(stat: StatValue | null): string {
  if (!stat || stat.value == null || !Number.isFinite(stat.value)) return "--";
  const { value, kind } = stat;
  if (kind === "count") return String(Math.round(value));
  if (kind === "ratio") return value.toFixed(2);
  if (kind === "percent") return `${value.toFixed(1)}%`;
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}
