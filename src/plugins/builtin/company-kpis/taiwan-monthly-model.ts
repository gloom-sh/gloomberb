import type {
  TaiwanBasketPoint,
  TaiwanRevenuePoint,
} from "../../../api-client/taiwan-revenue";
import { scalarPoint, staticSeries, type DataTableColumn } from "../../../components";
import type { ResolvedSeries } from "../../../time-series/types";
import { MISSING_VALUE, formatNumber } from "../../../utils/format";

export function fmtTwdB(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return MISSING_VALUE;
  if (value >= 1000) return `NT$${formatNumber(value / 1000, 2)}T`;
  if (value >= 10) return `NT$${formatNumber(value, 1)}B`;
  if (value >= 1) return `NT$${formatNumber(value, 2)}B`;
  return `NT$${Math.round(value * 1000).toLocaleString("en-US")}M`;
}

export function fmtSignedPct(
  value: number | null | undefined,
  suffix = "%",
): string {
  if (value == null || !Number.isFinite(value)) return MISSING_VALUE;
  if (value === 0) return `0.0${suffix}`;
  return `${value > 0 ? "+" : ""}${formatNumber(value, 1)}${suffix}`;
}

export function buildMonthlyRevenueSeries(
  pointsDesc: ReadonlyArray<Pick<TaiwanRevenuePoint, "yearMonth" | "revenueTwdB" | "yoyPct">>,
  colors: { revenue: string; yoy: string },
): ResolvedSeries[] {
  const asc = [...pointsDesc].slice(0, 24).reverse();
  if (asc.length < 2) return [];
  const revPoints = asc.map((p) =>
    scalarPoint(new Date(`${p.yearMonth}-10T00:00:00Z`), p.revenueTwdB),
  );
  return [
    staticSeries(revPoints, {
      id: "tw-monthly-rev",
      label: "Monthly Revenue (NT$ B)",
      color: colors.revenue,
      style: "columns",
    }),
  ];
}

export function buildBasketRevenueSeries(
  pointsDesc: readonly TaiwanBasketPoint[],
  colors: { revenue: string },
): ResolvedSeries[] {
  const asc = [...pointsDesc].slice(0, 24).reverse();
  if (asc.length < 2) return [];
  return [
    staticSeries(
      asc.map((p) =>
        scalarPoint(new Date(`${p.yearMonth}-10T00:00:00Z`), p.totalRevenueTwdB),
      ),
      {
        id: "tw-basket-rev",
        label: "Aggregate Supplier Sales (NT$ B)",
        color: colors.revenue,
        style: "columns",
      },
    ),
  ];
}

export function stockMonthlyColumns(width: number): DataTableColumn[] {
  const cols: DataTableColumn[] = [
    { id: "month", label: "Month", width: 9, align: "left" },
    { id: "revenue", label: "Revenue", width: 12, align: "right" },
    { id: "yoy", label: "YoY %", width: 9, align: "right" },
    { id: "accel", label: "Accel", width: 9, align: "right" },
    { id: "mom", label: "MoM %", width: 9, align: "right" },
    { id: "ytdYoy", label: "YTD YoY", width: 9, align: "right" },
  ];
  if (width >= 90) {
    cols.push({
      id: "note",
      label: "Disclosure Note",
      width: Math.max(18, width - 64),
      align: "left",
    });
  }
  return cols;
}

export function supplierBoardColumns(width: number): DataTableColumn[] {
  const cols: DataTableColumn[] = [
    { id: "code", label: "Code", width: 8, align: "left" },
    { id: "name", label: "Taiwan Supplier", width: width >= 96 ? 24 : 16, align: "left" },
    { id: "revenue", label: "Monthly Rev", width: 12, align: "right" },
    { id: "yoy", label: "YoY %", width: 9, align: "right" },
    { id: "accel", label: "Accel", width: 9, align: "right" },
    { id: "mom", label: "MoM %", width: 9, align: "right" },
  ];
  if (width >= 92) {
    cols.push({ id: "ytdYoy", label: "YTD YoY", width: 9, align: "right" });
  }
  return cols;
}
