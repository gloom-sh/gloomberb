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

/** An extended session a tick that names none of its own can be a print of. */
type TickSession = "PRE" | "POST";
const TICK_SESSIONS: readonly TickSession[] = ["PRE", "POST"];

export interface StreamTickRange {
  low: StreamTickReading;
  high: StreamTickReading;
  /** A tick after the first one at the low priced above it. */
  roseFromLow: boolean;
  /** A tick after the first one at the high priced below it. */
  fellFromHigh: boolean;
  /** The last tick's price, which the applied quote shows. */
  last: number;
  /**
   * The same ticks as a pre-market or after-hours quote shows them, once one
   * named no session but carried that session's print (an after-hours tick
   * with its print and the regular close): the quote they are applied onto
   * says which session they were in (`streamTicksAsShown`).
   */
  sessions?: Partial<Record<TickSession, StreamTickRange>>;
  regular?: StreamTickRange & { latest: StreamTickReading };
}

export function isRegularSessionPrint(quote: Pick<Quote, "marketState" | "overnightPrice">): boolean {
  return quote.marketState === "REGULAR" && quote.overnightPrice == null;
}

function reading(display: ActiveQuoteDisplay | null, quote: Quote): StreamTickReading | null {
  if (!display || !Number.isFinite(display.price)) return null;
  return { ...display, lastUpdated: quote.lastUpdated };
}

function tickReading(quote: Quote): StreamTickReading | null {
  if (quote.stale === true) return null;
  return reading(getActiveQuoteDisplay(quote), quote);
}

/**
 * A tick that names no session, read as a quote in `session` shows it, when
 * it carries that session's print; its move from the previous close when it
 * gives none.
 */
function sessionReading(quote: Quote, session: TickSession): StreamTickReading | null {
  if (quote.marketState != null || quote.stale === true) return null;
  const print = session === "PRE" ? quote.preMarketPrice : quote.postMarketPrice;
  if (print == null || !Number.isFinite(print) || (session === "PRE" && print <= 0)) return null;
  const display = getActiveQuoteDisplay({ ...quote, marketState: session });
  if (!display) return null;
  const close = quote.previousClose;
  const fromClose = close != null && Number.isFinite(close) && close > 0;
  return reading({
    price: display.price,
    change: display.change ?? (fromClose ? display.price - close : undefined),
    changePercent: display.changePercent ?? (fromClose ? ((display.price - close) / close) * 100 : undefined),
  }, quote);
}

function startRange(tick: StreamTickReading): StreamTickRange {
  return { low: tick, high: tick, roseFromLow: false, fellFromHigh: false, last: tick.price };
}

/** The range alone, without its sessions' views. */
function flatRange({ low, high, roseFromLow, fellFromHigh, last }: StreamTickRange): StreamTickRange {
  return { low, high, roseFromLow, fellFromHigh, last };
}

function foldReading(range: StreamTickRange, tick: StreamTickReading): void {
  const { price } = tick;
  if (price < range.low.price) {
    range.low = tick;
    range.roseFromLow = false;
  } else if (price > range.low.price) range.roseFromLow = true;
  if (price > range.high.price) {
    range.high = tick;
    range.fellFromHigh = false;
  } else if (price < range.high.price) range.fellFromHigh = true;
  range.last = price;
}

function foldSessionReading(range: StreamTickRange, session: TickSession, sessionTick: StreamTickReading | null, tick: StreamTickReading): void {
  // A session's view starts as the ticks before read: none of them carried its print.
  if (sessionTick && !range.sessions?.[session]) (range.sessions ??= {})[session] = flatRange(range);
  const view = range.sessions?.[session];
  if (view) foldReading(view, sessionTick ?? tick);
}

/** The range with one more tick, in arrival order; a range it starts. Mutates `range`, which the caller owns. */
export function foldStreamTick(range: StreamTickRange | null, quote: Quote): StreamTickRange | null {
  const tick = tickReading(quote);
  if (!tick) return range;
  const pre = sessionReading(quote, "PRE");
  const post = sessionReading(quote, "POST");
  if (!range) {
    const started = startRange(tick);
    if (isRegularSessionPrint(quote)) started.regular = { ...startRange(tick), latest: tick };
    if (pre) (started.sessions ??= {}).PRE = startRange(pre);
    if (post) (started.sessions ??= {}).POST = startRange(post);
    return started;
  }
  if (isRegularSessionPrint(quote)) {
    if (range.regular) {
      foldReading(range.regular, tick);
      range.regular.latest = tick;
    } else range.regular = { ...startRange(tick), latest: tick };
  }
  if (pre || post || range.sessions) {
    foldSessionReading(range, "PRE", pre, tick);
    foldSessionReading(range, "POST", post, tick);
  }
  foldReading(range, tick);
  return range;
}

function mergeFlat(earlier: StreamTickRange, later: StreamTickRange): StreamTickRange {
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

/** Two ranges as one, `later`'s ticks after `earlier`'s. */
export function mergeStreamTickRanges(earlier: StreamTickRange | undefined, later: StreamTickRange): StreamTickRange {
  if (!earlier) return later;
  const merged = mergeFlat(earlier, later);
  if (earlier.regular || later.regular) {
    merged.regular = earlier.regular && later.regular
      ? { ...mergeFlat(earlier.regular, later.regular), latest: later.regular.latest } : earlier.regular ?? later.regular;
  }
  for (const session of TICK_SESSIONS) {
    const before = earlier.sessions?.[session];
    const after = later.sessions?.[session];
    // A range with no view of the session reads every tick of it as it reads it.
    if (before || after) (merged.sessions ??= {})[session] = mergeFlat(before ?? earlier, after ?? later);
  }
  return merged;
}

/** Whether any tick priced other than the last: the applied quote alone says everything the others did. */
function spansOtherPrices(range: StreamTickRange): boolean {
  return range.low.price < range.last || range.high.price > range.last;
}

/** Whether the range, in any session it can be read in, says something the newest tick alone does not. */
export function carriesOtherPrices(range: StreamTickRange): boolean {
  return spansOtherPrices(range) || TICK_SESSIONS.some((session) => {
    const view = range.sessions?.[session];
    return view != null && spansOtherPrices(view);
  });
}

/**
 * The range as `applied`, the quote its last tick left, shows its price: in
 * that quote's session when ticks named none (`sessions`). Null when that
 * quote does not show their last price, so the ticks are not what it shows
 * (a unit its listing's other quotes refuse, an older print than its
 * snapshot), or when they all priced as it does.
 */
export function streamTicksAsShown(range: StreamTickRange, applied: Quote): StreamTickRange | null {
  if (applied.stale === true) return null;
  const shown = getActiveQuoteDisplay(applied)?.price;
  const state = applied.marketState;
  const session = state === "PRE" || state === "PREPRE" ? range.sessions?.PRE
    : state === "POST" || state === "POSTPOST" ? range.sessions?.POST : undefined;
  for (const view of [session, range]) {
    if (!view || view.last !== shown) continue;
    return (spansOtherPrices(view) || (range.regular && !isRegularSessionPrint(applied)))
      ? { ...flatRange(view), ...(range.regular ? { regular: range.regular } : {}) } : null;
  }
  return null;
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readReading(value: unknown): StreamTickReading | null {
  if (!value || typeof value !== "object") return null;
  const tick = value as Record<string, unknown>;
  const price = finiteOrUndefined(tick.price);
  if (price === undefined) return null;
  return { price, change: finiteOrUndefined(tick.change), changePercent: finiteOrUndefined(tick.changePercent), lastUpdated: finiteOrUndefined(tick.lastUpdated) };
}

function readFlatRange(value: unknown): StreamTickRange | undefined {
  if (!value || typeof value !== "object") return undefined;
  const range = value as Record<string, unknown>;
  const low = readReading(range.low);
  const high = readReading(range.high);
  const last = finiteOrUndefined(range.last);
  if (!low || !high || last === undefined || typeof range.roseFromLow !== "boolean" || typeof range.fellFromHigh !== "boolean") return undefined;
  if (low.price > last || high.price < last) return undefined;
  return { low, high, roseFromLow: range.roseFromLow, fellFromHigh: range.fellFromHigh, last };
}

/**
 * A range as it crossed from another process in JSON (a desktop window's
 * quote batch), where an unavailable move arrives as null. Undefined for
 * anything that is not one.
 */
export function readStreamTickRange(value: unknown): StreamTickRange | undefined {
  const range = readFlatRange(value);
  if (!range) return undefined;
  const rawRegular = (value as { regular?: { latest?: unknown } }).regular;
  const regular = readFlatRange(rawRegular);
  const latest = readReading(rawRegular?.latest);
  if (regular && latest?.price === regular.last) range.regular = { ...regular, latest };
  const sessions = (value as { sessions?: unknown }).sessions;
  for (const session of TICK_SESSIONS) {
    const view = sessions && typeof sessions === "object" ? readFlatRange((sessions as Record<string, unknown>)[session]) : undefined;
    if (view) (range.sessions ??= {})[session] = view;
  }
  return range;
}
