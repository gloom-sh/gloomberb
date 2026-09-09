import type { TickerFinancials } from "../types/financials";
import { formatCompact, formatNumber } from "../utils/format";
import { getTimeSeriesField } from "./field-catalog";
import { extractFundamentalSeries } from "./fundamentals";
import type { ResolvedSeries, SecuritySeriesSource } from "./types";

export type GraphKind = "fundamental" | "valuation";
export type FundamentalPeriod = "annual" | "quarterly";
export type GraphMetricKey = string;

export interface FundamentalGraphRow {
  key: string;
  symbol: string;
  date: string;
  category: string;
  value: number;
  growth: number | null;
  barWidth: number;
}

export interface MetricDefinition {
  key: GraphMetricKey;
  label: string;
  format: (value: number) => string;
}

function fieldId(kind: GraphKind, metric: GraphMetricKey): string {
  return `${kind === "valuation" ? "valuation" : "fundamental"}.${metric}`;
}

function formatMetricValue(id: string, value: number): string {
  if (id.includes("Margin")) return `${formatNumber(value, 1)}%`;
  if (id.startsWith("valuation.")) return `${formatNumber(value, id.endsWith("pegRatio") ? 2 : 1)}x`;
  if (id.endsWith("eps")) return formatNumber(value, 2);
  return formatCompact(value);
}

export function metricDef(kind: GraphKind, metric: GraphMetricKey): MetricDefinition {
  const id = fieldId(kind, metric);
  const definition = getTimeSeriesField(id);
  return {
    key: metric,
    label: definition?.label ?? metric,
    format: (value) => formatMetricValue(id, value),
  };
}

export function graphRowsForFinancials(
  financials: TickerFinancials | null,
  kind: GraphKind,
  metric: GraphMetricKey,
  period: FundamentalPeriod,
  symbol: string,
): FundamentalGraphRow[] {
  const source: SecuritySeriesSource = {
    kind: "security",
    instrument: { symbol },
    fieldId: fieldId(kind, metric),
    period,
    timestampMode: "period-end",
  };
  const points = extractFundamentalSeries(financials, source)
    .filter((point): point is typeof point & { value: number } => typeof point.value === "number" && Number.isFinite(point.value))
    .sort((left, right) => left.observedAt.getTime() - right.observedAt.getTime());
  const maximum = Math.max(1, ...points.map((point) => Math.abs(point.value)));
  return points.map((point, index) => {
    const previous = points[index - 1]?.value;
    const current = point.value;
    const currentLabel = point.periodLabel === "Current";
    const date = currentLabel ? "Current" : point.observedAt.toISOString().slice(0, 10);
    return {
      key: `${symbol}:${date}:${metric}`,
      symbol,
      date,
      category: point.periodLabel ?? date,
      value: current,
      growth: typeof previous === "number" && previous !== 0
        ? (current - previous) / Math.abs(previous)
        : null,
      barWidth: Math.max(1, Math.round((Math.abs(current) / maximum) * 24)),
    };
  });
}

export function limitGraphRowsBySymbol(
  rows: FundamentalGraphRow[],
  periodCount: number | null | undefined,
): FundamentalGraphRow[] {
  if (!Number.isInteger(periodCount) || periodCount == null || periodCount <= 0) return rows;
  const keysToKeep = new Set<string>();
  for (const symbol of new Set(rows.map((row) => row.symbol))) {
    const sorted = rows
      .filter((row) => row.symbol === symbol)
      .sort((left, right) => left.date.localeCompare(right.date));
    for (const row of sorted.slice(-periodCount)) keysToKeep.add(row.key);
  }
  return rows.filter((row) => keysToKeep.has(row.key));
}

/** Export raw endpoints even when a chart displays percentages, indices, or logs. */
export function summarizeResolvedSeries(series: ResolvedSeries) {
  const observations = series.points.flatMap((point) => {
    const value = point.rawValue === undefined ? point.value ?? point.close : point.rawValue;
    return typeof value === "number" && Number.isFinite(value) ? [{ date: point.date, value }] : [];
  });
  const first = observations[0];
  const last = observations.at(-1);
  return {
    startDate: first?.date.toISOString() ?? null,
    endDate: last?.date.toISOString() ?? null,
    startValue: first?.value ?? null,
    endValue: last?.value ?? null,
    return: first && last && first.value !== 0 ? (last.value - first.value) / first.value : null,
    unit: series.rawUnit ?? series.unit,
    pointCount: series.points.length,
  };
}
