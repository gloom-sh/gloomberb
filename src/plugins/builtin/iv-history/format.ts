import type { IvStatRow, IvStatUnit, RichCheap } from "./model";

export const formatVol = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "--" : `${(value * 100).toFixed(1)}%`;
export const formatPoints = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value) ? "--" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}`;
export const formatRank = (value: number | null | undefined, suffix = "") =>
  value == null || !Number.isFinite(value) ? "--" : `${Math.round(value)}${suffix ? ` ${suffix}` : ""}`;
export const shortDate = (date: string | null | undefined) => date ? date.slice(5) : "--";
export const verdictLabel = (verdict: RichCheap) => verdict === "rich" ? "Rich" : verdict === "cheap" ? "Cheap" : verdict === "fair" ? "Fair" : "--";

/** A statistic in its own unit: volatility %, volatility points, or a plain ratio. */
export function formatStat(value: number | null | undefined, unit: IvStatUnit): string {
  if (value == null || !Number.isFinite(value)) return "--";
  return unit === "vol" ? formatVol(value) : unit === "points" ? formatPoints(value) : value.toFixed(2);
}
export function statSource(row: Pick<IvStatRow, "method">): string {
  return row.method === "quote-mid" ? "live" : row.method === "prices" ? "closes" : row.method === "trade-close" ? "close" : "";
}
