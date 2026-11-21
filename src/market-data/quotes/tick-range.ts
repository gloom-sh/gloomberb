import type { Quote } from "../../types/financials";
import { getActiveQuoteDisplay, type ActiveQuoteDisplay } from "../market/status";

/**
 * A data frame applies only the newest tick of each key, and a key off
 * screen waits a second between applies. What the ticks it folded in did is
 * kept as their range, read as the active session shows a price
 * (getActiveQuoteDisplay), so a reader that judges every tick (price alerts)
 * still sees one that crossed a level and came back before its frame.
 */

/** One tick at an edge of the range: its active-session price and move, and when it printed. */
export interface StreamTickReading extends ActiveQuoteDisplay {
  lastUpdated?: number;
}

export interface StreamTickRange {
  low: StreamTickReading;
  high: StreamTickReading;
  /** A tick after the first one at the low priced above it. */
  roseFromLow: boolean;
  /** A tick after the first one at the high priced below it. */
  fellFromHigh: boolean;
  /** The last tick's price, which the applied quote shows. */
  last: number;
}

function tickReading(quote: Quote): StreamTickReading | null {
  if (quote.stale === true) return null;
  const display = getActiveQuoteDisplay(quote);
  if (!display || !Number.isFinite(display.price)) return null;
  return { ...display, lastUpdated: quote.lastUpdated };
}

/** The range with one more tick, in arrival order; a range it starts. Mutates `range`, which the caller owns. */
export function foldStreamTick(range: StreamTickRange | null, quote: Quote): StreamTickRange | null {
  const reading = tickReading(quote);
  if (!reading) return range;
  if (!range) return { low: reading, high: reading, roseFromLow: false, fellFromHigh: false, last: reading.price };
  const { price } = reading;
  if (price < range.low.price) {
    range.low = reading;
    range.roseFromLow = false;
  } else if (price > range.low.price) range.roseFromLow = true;
  if (price > range.high.price) {
    range.high = reading;
    range.fellFromHigh = false;
  } else if (price < range.high.price) range.fellFromHigh = true;
  range.last = price;
  return range;
}

/** Two ranges as one, `later`'s ticks after `earlier`'s. */
export function mergeStreamTickRanges(earlier: StreamTickRange | undefined, later: StreamTickRange): StreamTickRange {
  if (!earlier) return later;
  const lower = later.low.price < earlier.low.price;
  const higher = later.high.price > earlier.high.price;
  return {
    low: lower ? later.low : earlier.low,
    high: higher ? later.high : earlier.high,
    // Every later tick comes after the earlier low: one above it is a rise from it.
    roseFromLow: lower ? later.roseFromLow : earlier.roseFromLow || later.high.price > earlier.low.price,
    fellFromHigh: higher ? later.fellFromHigh : earlier.fellFromHigh || later.low.price < earlier.high.price,
    last: later.last,
  };
}

/** Whether any tick priced other than the last: the applied quote alone says everything the others did. */
export function spansOtherPrices(range: StreamTickRange): boolean {
  return range.low.price < range.last || range.high.price > range.last;
}
