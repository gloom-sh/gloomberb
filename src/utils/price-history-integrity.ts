import { medianBarGap } from "../time-series/bar-spacing";
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

/**
 * A wick too far from its bar's body to have traded: a low under half the lower
 * of open and close, or a high over twice the higher, as `low<close/2` or
 * `high>2*open` (IAG on LSE, 2021-11-29: a low of 0.0155 under a close of
 * 1.316). Only that wick is withheld: the open and close stand, so closes,
 * returns and drawdowns read the bar while lows, highs and ranges do not.
 * Empty when the wicks are plausible, or when the bar's prices contradict
 * each other, which blanks it whole (pricePointIntegrityFlags).
 */
export function pricePointWickFlags(point: PricePoint): string[] {
  const { open, high, low, close } = point;
  if (pricePointIntegrityFlags(point).length > 0) return [];
  const body = [["open", open], ["close", close]].filter((entry): entry is [string, number] => isFiniteNumber(entry[1]));
  if (body.length === 0) return [];
  // On a tie the close names the side, as the price the bar is read by.
  const [bottomName, bottom] = body.reduce((least, entry) => entry[1] <= least[1] ? entry : least);
  const [topName, top] = body.reduce((most, entry) => entry[1] >= most[1] ? entry : most);
  const flags: string[] = [];
  if (isFiniteNumber(low) && bottom > 0 && low < bottom / 2) flags.push(`low<${bottomName}/2`);
  if (isFiniteNumber(high) && top > 0 && high > top * 2) flags.push(`high>2*${topName}`);
  return flags;
}

/** Whether a flag code is a withheld wick (pricePointWickFlags), whose bar keeps its open and close. */
export function isWickFlag(code: string): boolean {
  return /^(low<(open|close)\/2|high>2\*(open|close))$/.test(code);
}

/** A bar's high and low with a wick too far from its body to have traded (pricePointWickFlags) left out. */
export function pricePointWicks(point: PricePoint): { high: number | undefined; low: number | undefined } {
  const flags = pricePointWickFlags(point);
  return {
    high: flags.some((flag) => flag.startsWith("high")) ? undefined : point.high,
    low: flags.some((flag) => flag.startsWith("low")) ? undefined : point.low,
  };
}

/** "1 bar has a low or high too far from its open and close to have traded; left out of ranges.", or undefined for none. */
export function priceHistoryWickNotice(count: number): string | undefined {
  return count > 0
    ? `${count === 1 ? "1 bar has a low or high" : `${count} bars have lows or highs`} too far from ${count === 1 ? "its" : "their"} open and close to have traded; left out of ranges.`
    : undefined;
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
  // A wick too far from the body to have traded is left out; the rest of the bar stands.
  const wicks = pricePointWicks(point);
  return {
    open: value(point.open), high: value(wicks.high), low: value(wicks.low),
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
 * "2 of 178 bars have no reported volume (\u2014)": the bars of a history that reports volume whose own is missing,
 * such as a coin's hours its trading venues did not report, which are never read as 0. `missing` counts only bars
 * without a reason of their own (still forming, rebuilt, prices left blank as contradictory, the latest trade).
 * Undefined when there are none.
 */
export function missingVolumeNotice(missing: number, total: number): string | undefined {
  if (missing <= 0) return undefined;
  return `${missing} of ${total} ${missing === 1 && total === 1 ? "bar" : "bars"} ${missing === 1 ? "has" : "have"} no reported volume (${MISSING_VOLUME_TEXT})`;
}

/** Bars spaced less than this apart are intraday; daily bars can be stamped at a session open, hours from midnight. */
const INTRADAY_BAR_MAX_MS = 20 * 60 * 60 * 1000;

/**
 * Where a history's newest point is the latest trade instead of a bar, else -1. Some sources end an intraday history
 * with the latest trade stamped at its own time, inside the bar before it (15:57:53 after the 15:00 bar of hourly
 * bars): less than a bar after it, off the bars' grid. It belongs to that bar, as charts fold it in (live-bars.ts), so
 * it has no volume of its own and is never a bar without reported volume. `times` may be in any order.
 */
export function latestTradeIndex(times: readonly number[]): number {
  const order = times.map((time, index) => ({ time, index }))
    .filter(({ time }) => Number.isFinite(time))
    .sort((left, right) => left.time - right.time);
  if (order.length < 3) return -1;
  const last = order.at(-1)!;
  const gap = last.time - order.at(-2)!.time;
  const step = medianBarGap(order.slice(0, -1).map(({ time }) => time));
  return step != null && step < INTRADAY_BAR_MAX_MS && gap > 0 && gap < step ? last.index : -1;
}

/** A bar's time, whether it carries a Date, an ISO date or a timestamp; NaN without one. */
function barTime(date: Date | string | number | undefined): number {
  if (date instanceof Date) return date.getTime();
  if (typeof date === "number") return date;
  return typeof date === "string" ? Date.parse(date) : Number.NaN;
}

/**
 * The bars of a history that reports volume left without it for no reason of their own: not still forming, not
 * rebuilt from hourly bars, not blank for contradictory prices and not the latest trade (latestTradeIndex), as
 * `history` counts them. 0 for a history that reports no volume at all, such as an index or a currency pair.
 */
export function missingVolumeCount(bars: readonly {
  volume: number | null; integrity?: unknown; partial?: boolean; filled?: boolean; date?: Date | string | number;
}[]): number {
  if (!bars.some((bar) => bar.volume != null)) return 0;
  const latestTrade = latestTradeIndex(bars.map((bar) => barTime(bar.date)));
  return bars.filter((bar, index) => bar.volume == null && !bar.integrity && !bar.partial && !bar.filled
    && index !== latestTrade).length;
}
