import type { DataTableColumn } from "../../../components";
import type {
  RevenueBreakdownPayload,
  RevenueBreakdownPeriod,
  RevenueBreakdownRow,
  RevenueBreakdownView,
} from "../../../api-client/revenue-breakdown";

/**
 * Trend scales each row's bars to its own range, so shape reads at a glance;
 * Actual puts every row on one scale, so size does; Text shows the numbers.
 */
export type RevenueMode = "trend" | "actual" | "text";
export const REVENUE_MODES: { value: RevenueMode; label: string }[] = [
  { value: "trend", label: "Trend" },
  { value: "actual", label: "Actual" },
  { value: "text", label: "Text" },
];

export const VIEW_NOUNS: Record<RevenueBreakdownView, { label: string; plural: string }> = {
  product: { label: "Product", plural: "product" },
  segment: { label: "Segment", plural: "segment" },
  region: { label: "Region", plural: "region" },
};

export type RevenueSortColumn = "label" | "trend" | "revenue" | "ttm" | "share" | "yoy" | `q${number}`;
export interface RevenueSort {
  column: RevenueSortColumn;
  direction: "asc" | "desc";
}

export const quarterLabel = (period: RevenueBreakdownPeriod) =>
  `Q${period.fiscalQuarter} ${period.fiscalYear}`;

/**
 * Drop leading quarters no row was reported for, so a young company, or rows
 * a company only started disclosing (NVIDIA's Hyperscale), start at their
 * first quarter instead of a run of empty slots.
 */
export function reportedSpan(payload: RevenueBreakdownPayload): RevenueBreakdownPayload {
  const first = payload.periods.findIndex((_, index) =>
    payload.rows.some((row) => row.values[index] !== null));
  if (first <= 0) return payload;
  return {
    ...payload,
    periods: payload.periods.slice(first),
    total: payload.total.slice(first),
    rows: payload.rows.map((row) => ({ ...row, values: row.values.slice(first) })),
  };
}

/** Bar heights in 0..1, null where the quarter was not reported. */
export function barLevels(values: (number | null)[], mode: RevenueMode, sharedMax: number): (number | null)[] {
  const reported = values.filter((value): value is number => value !== null && value > 0);
  if (mode === "actual") {
    return values.map((value) =>
      value === null ? null : sharedMax > 0 ? Math.max(value > 0 ? 0.06 : 0, value / sharedMax) : 0);
  }
  const low = Math.min(...reported);
  const high = Math.max(...reported);
  return values.map((value) => {
    if (value === null) return null;
    if (value <= 0) return 0;
    // The row's lowest quarter still draws a quarter-height bar, so a reported
    // quarter never reads as an empty slot, and a flat row reads as a line.
    return high > low ? 0.25 + 0.75 * ((value - low) / (high - low)) : 0.6;
  });
}

export function sharedMaximum(rows: RevenueBreakdownRow[]): number {
  let max = 0;
  for (const row of rows) for (const value of row.values) if (value !== null && value > max) max = value;
  return max;
}

/** Three significant figures: 54.3B, 246B, 7.88B, 380M. */
export function revenueAmount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "--";
  const abs = Math.abs(value);
  const [divisor, suffix] = abs >= 1e12 ? [1e12, "T"] : abs >= 1e9 ? [1e9, "B"] : abs >= 1e6 ? [1e6, "M"] : abs >= 1e3 ? [1e3, "K"] : [1, ""];
  const scaled = abs / divisor;
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${value < 0 ? "-" : ""}${scaled.toFixed(digits)}${suffix}`;
}

export const sharePercent = (value: number | null) =>
  value === null ? "--" : `${(value * 100).toFixed(1)}%`;

export const growthPercent = (value: number | null) =>
  value === null ? "--" : `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;

function sortValue(row: RevenueBreakdownRow, column: RevenueSortColumn): number | string | null {
  if (column === "label") return row.label.toLowerCase();
  if (column === "trend") {
    // Growth across the quarters shown, first reported to last.
    const reported = row.values.filter((value): value is number => value !== null);
    const first = reported[0];
    return reported.length > 1 && first !== undefined && first > 0 ? reported.at(-1)! / first - 1 : null;
  }
  if (column === "revenue") return row.values.at(-1) ?? null;
  if (column === "ttm") return row.ttm;
  if (column === "share") return row.share;
  if (column === "yoy") return row.yoy;
  return row.values[Number(column.slice(1))] ?? null;
}

/** Sorted rows; unreported values go last either way. */
export function sortRevenueRows(rows: RevenueBreakdownRow[], sort: RevenueSort): RevenueBreakdownRow[] {
  const sign = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    const a = sortValue(left, sort.column);
    const b = sortValue(right, sort.column);
    if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
    return (a < b ? -1 : a > b ? 1 : 0) * sign;
  });
}

export function nextRevenueSort(current: RevenueSort, column: string): RevenueSort {
  const id = column as RevenueSortColumn;
  if (current.column === id) return { column: id, direction: current.direction === "desc" ? "asc" : "desc" };
  return { column: id, direction: id === "label" ? "asc" : "desc" };
}

export const BAR_CELLS_PER_QUARTER = 2;
const NUMBER_WIDTH = 9;

export function revenueColumns(
  payload: RevenueBreakdownPayload,
  mode: RevenueMode,
): DataTableColumn[] {
  const labelWidth = Math.min(34, Math.max(12, ...payload.rows.map((row) => row.label.length + 2)));
  const latest = payload.periods.at(-1)!;
  const first = payload.periods[0]!;
  const history: DataTableColumn[] = mode === "text"
    ? payload.periods.slice(0, -1).map((period, index) => ({
      id: `q${index}`,
      label: quarterLabel(period),
      width: NUMBER_WIDTH,
      align: "right" as const,
    }))
    : [{
      id: "trend",
      label: payload.periods.length > 1 ? `${quarterLabel(first)} – ${quarterLabel(latest)}` : quarterLabel(latest),
      width: Math.max(18, payload.periods.length * BAR_CELLS_PER_QUARTER + 1),
      align: "left" as const,
      // Spare width goes to the bars, which sit right after the names.
      flexGrow: 1,
    }];
  return [
    { id: "label", label: VIEW_NOUNS[payload.view].label, width: labelWidth, align: "left", ...(mode === "text" ? { flexGrow: 1 } : {}) },
    ...history,
    { id: "revenue", label: quarterLabel(latest), width: NUMBER_WIDTH, align: "right" },
    { id: "ttm", label: "TTM", width: NUMBER_WIDTH - 1, align: "right" },
    { id: "share", label: "% Total", width: NUMBER_WIDTH, align: "right" },
    { id: "yoy", label: "YoY", width: NUMBER_WIDTH - 1, align: "right" },
  ];
}
