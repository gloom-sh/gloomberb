import type { PricePoint } from "../types/financials";
import { isFiniteNumber } from "./guards";

type ReportedPricePoint = Readonly<Omit<PricePoint, "date" | "historySource"> & {
  date: string;
  historySource?: Readonly<NonNullable<PricePoint["historySource"]>>;
}>;

export interface PriceHistoryIntegrity {
  readonly reason: "inconsistent-ohlc";
  /** Original reported values, retained for inspection, never used as replacements. */
  readonly sourcePoints: ReadonlyArray<ReportedPricePoint>;
}

function snapshotReportedPoint(point: ReportedPricePoint): ReportedPricePoint {
  return Object.freeze({ ...point, ...(point.historySource ? { historySource: Object.freeze({ ...point.historySource }) } : {}) });
}

export function mergePriceHistoryIntegrity(...entries: readonly PriceHistoryIntegrity[]): PriceHistoryIntegrity {
  return Object.freeze({
    reason: "inconsistent-ohlc",
    sourcePoints: Object.freeze(entries.flatMap((entry) => entry.sourcePoints.map(snapshotReportedPoint))),
  });
}

function above(left: number, right: number): boolean {
  return left - right > 8 * Number.EPSILON * Math.max(Math.abs(left), Math.abs(right));
}

/**
 * Each way a bar's prices contradict each other, as short codes such as
 * `high<open` or `low>close`; empty when they agree. Missing OHLC fields are
 * not contradictory: close-only histories remain usable.
 */
export function pricePointIntegrityFlags(point: PricePoint): string[] {
  const { open, high, low, close } = point;
  const flags: string[] = [];
  for (const [name, value] of [["open", open], ["close", close]] as const) {
    if (isFiniteNumber(value) && isFiniteNumber(high) && above(value, high)) flags.push(`high<${name}`);
  }
  for (const [name, value] of [["open", open], ["close", close]] as const) {
    if (isFiniteNumber(value) && isFiniteNumber(low) && above(low, value)) flags.push(`low>${name}`);
  }
  if (isFiniteNumber(high) && isFiniteNumber(low) && above(low, high)) flags.push("low>high");
  return flags;
}

export function pricePointIntegrity(point: PricePoint): PriceHistoryIntegrity | undefined {
  if (pricePointIntegrityFlags(point).length === 0) return undefined;
  const date = new Date(point.date);
  return Object.freeze({
    reason: "inconsistent-ohlc",
    sourcePoints: Object.freeze([snapshotReportedPoint({ ...point, date: Number.isFinite(date.getTime()) ? date.toISOString() : String(point.date) })]),
  });
}

/** Calculation/display fields deliberately exclude the contradictory source row. */
export function pricePointValues(point: PricePoint, integrity = pricePointIntegrity(point)) {
  const value = (number: number | undefined) => !integrity && isFiniteNumber(number) ? number : null;
  return {
    open: value(point.open), high: value(point.high), low: value(point.low),
    close: value(point.close), volume: value(point.volume),
    ...(integrity ? { integrity } : {}),
  };
}

export function priceHistoryIntegrityNotice(count: number): string | undefined {
  return count > 0
    ? `${count} inconsistent OHLC ${count === 1 ? "bar is" : "bars are"} unavailable. Affected calculations contain gaps; original values and reasons are retained in JSON exports.`
    : undefined;
}

/** What a bar without volume shows in a history that reports volume: missing, never 0. */
export const MISSING_VOLUME_TEXT = "\u2014";

/**
 * "90 of 178 bars have no reported volume (\u2014)": the bars of a history that reports volume whose own is missing,
 * such as the hours a coin's feed leaves without volume, which are never read as 0. `missing` counts only bars without
 * a reason of their own (still forming, rebuilt, prices left blank as contradictory). Undefined when there are none.
 */
export function missingVolumeNotice(missing: number, total: number): string | undefined {
  if (missing <= 0) return undefined;
  return `${missing} of ${total} ${missing === 1 && total === 1 ? "bar" : "bars"} ${missing === 1 ? "has" : "have"} no reported volume (${MISSING_VOLUME_TEXT})`;
}

/**
 * The bars of a history that reports volume left without it for no reason of their own: not still forming, not
 * rebuilt from hourly bars and not blank for contradictory prices, as `history` counts them. 0 for a history that
 * reports no volume at all, such as an index or a currency pair.
 */
export function missingVolumeCount(bars: readonly { volume: number | null; integrity?: unknown; partial?: boolean; filled?: boolean }[]): number {
  if (!bars.some((bar) => bar.volume != null)) return 0;
  return bars.filter((bar) => bar.volume == null && !bar.integrity && !bar.partial && !bar.filled).length;
}
