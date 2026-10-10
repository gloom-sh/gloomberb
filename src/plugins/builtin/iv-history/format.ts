import type { IvMethod } from "./client";
import type { IvStatRow, IvStatUnit, RichCheap, RichCheapDates } from "./model";

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
/**
 * How a stored reading was taken. A quote capture is the option quote mids
 * from the minutes before the close, taken once a session and never updated:
 * it is not a live feed, so it is not called live.
 */
const readingSource = (method: IvMethod | null | undefined) => method === "quote-mid" ? "quote" : "close";
export function statSource(row: Pick<IvStatRow, "method">): string {
  return row.method === "prices" ? "closes" : row.method ? readingSource(row.method) : "";
}
/** "2026-10-09 quote": the session a reading belongs to and how it was taken. */
export const readingLabel = (date: string, method: IvMethod | null | undefined, short = false) =>
  `${short ? shortDate(date) : date} ${readingSource(method)}`;
/**
 * The dates every row agrees on, said once: the reading's, and the trade close
 * its rank is measured on. `short` is for a footer with little room: month and
 * day, and no window.
 */
export function sharedDates({ reading, rank }: Pick<RichCheapDates, "reading" | "rank">, short = false): string[] {
  if (reading?.method === "trade-close" && reading.date === rank) return [readingLabel(reading.date, reading.method, short)];
  return [reading && `IV30 ${readingLabel(reading.date, reading.method, short)}`,
    rank && (short ? `IVR/IVP ${shortDate(rank)} close` : `IVR/IVP vs 52 weeks to ${rank} close`)].filter((part): part is string => !!part);
}
