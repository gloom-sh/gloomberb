import type { IvCloseBasis, IvMethod } from "./client";
import { readingSource, type IvStatRow, type IvStatUnit, type RichCheap, type RichCheapDates } from "./model";

/**
 * VCA's sign conventions, and what VIX is beside an at-the-money IV30, one
 * line each: under the table, in the shot and in the report's notes. The skew
 * is the stored 25-delta put and call IVs at a 30-day constant maturity, from
 * the latest quote capture; both differences are decimal IV shown in points.
 * Its line is there only while a skew column is.
 */
export function vcaDefinitions({ skew }: { skew: boolean }): string[] {
  return [
    ...(skew ? ["25D skew: 30-day 25-delta put IV minus 25-delta call IV, in vol points; positive means puts are richer."] : []),
    "30-90: IV30 minus IV90. IV/HV: IV30 over the HV20 of the same date.",
    "VIX is Cboe's 30-day S&P 500 implied vol from the whole SPX strike strip, skew included; IV30 here is at the money, so VIX usually reads higher.",
  ];
}

/** Words for implied volatility that are no function's code: `fn IVOL` names HIVG and OVDV, which list them as `suggestFor`. */
export const IMPLIED_VOL_WORDS = ["IVOL", "IV", "OVOL", "IMPVOL", "IMPLIEDVOL"];

/**
 * A skew column's header names its sign, since the conventions differ: the
 * 25-delta skew is put minus call (HIVG, VCA), the risk reversal call minus
 * put (OVDV). "skew25d put-call (pts)": the stem a script keys on, the
 * sign, and vol points in the unit's usual place, as in "IV30 (%)". No
 * comma, so a CSV header needs no quoting.
 */
export const skewHeader = (stem: string, sign: string) => `${stem} ${sign} (pts)`;

/** The underlying price a reading was taken at, to the cent. */
export const formatSpot = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "--"
  : value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
 * it is not a live feed, so it is not called live. A close solved from quote
 * midpoints, where its prints were off the market, says so.
 */
export function statSource(row: Pick<IvStatRow, "method"> & { basis?: IvCloseBasis | null }): string {
  return row.method === "prices" ? "closes" : row.method ? readingSource(row.method, row.basis) : "";
}
/**
 * "2026-10-09 quote": the session a reading belongs to and how it was taken.
 * A stale reading says so instead, "2026-05-18 close, stale", and in the short
 * form "05-18 stale".
 */
export function readingLabel(date: string, method: IvMethod | null | undefined, short = false,
  extra: { basis?: IvCloseBasis | null; stale?: boolean } = {}): string {
  if (extra.stale) return short ? `${shortDate(date)} stale` : `${date} ${readingSource(method, extra.basis)}, stale`;
  return `${short ? shortDate(date) : date} ${readingSource(method, extra.basis)}`;
}
/**
 * The dates every row agrees on, said once: the reading's, and the trade close
 * its rank is measured on. `short` is for a footer with little room: month and
 * day, and no window.
 */
export function sharedDates({ reading, rank }: Pick<RichCheapDates, "reading" | "rank">, short = false): string[] {
  if (reading?.method === "trade-close" && reading.date === rank) return [readingLabel(reading.date, reading.method, short, { basis: reading.basis })];
  return [reading && `IV30 ${readingLabel(reading.date, reading.method, short, { basis: reading.basis })}`,
    rank && (short ? `IVR/IVP ${shortDate(rank)} close` : `IVR/IVP vs 52 weeks to ${rank} close`)].filter((part): part is string => !!part);
}
