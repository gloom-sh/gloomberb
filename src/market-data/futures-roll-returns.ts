import type { PricePoint } from "../types/financials";
import { getPricePointTimestamp } from "../utils/price-history";
import { pricePointOpenWithheld } from "../utils/price-history-integrity";

/** What a return-based function says once about a continuous future's series (rollAdjustedHistory). */
export const ROLLS_BACK_ADJUSTED = "rolls back-adjusted";
/** What it says of a continuous future whose bars name no contract and whose root the calendar does not have. */
const ROLLS_LEFT_AS_TRADED = "rolls left as traded";

/** A roll in a continuous future's daily bars, as rollAdjustedHistory closed it. */
interface ReturnRoll {
  /** The first bar on the incoming contract, YYYY-MM-DD. */
  date: string;
  /** The contracts either side (NGX26, NGZ26), from the bars or the contract calendar. */
  from: string;
  to: string;
  /** Where the roll was found: a change of contract in the bars, or the contract calendar before they name one. */
  source: "bars" | "calendar";
  /**
   * What the roll day's return was read from: the incoming contract's own
   * move from the bar's open (its first trade of the session), or none
   * (`flat`) for a bar that has no open to read.
   */
  basis: "open" | "flat";
}

export interface RollAdjustedHistory {
  /**
   * The same bars, every price before a roll scaled by its gap (back-adjusted
   * by ratio), so a return across a roll is one contract's. Volumes and every
   * other field are as served. For returns only: levels, charts and `history`
   * show the prices as traded.
   */
  points: PricePoint[];
  rolls: ReturnRoll[];
  /**
   * "rolls back-adjusted"; from when, when the bars before name no contract
   * and the calendar does not have the root ("rolls back-adjusted from
   * 2026-09-08"); "rolls left as traded" when neither says where a roll is.
   * Null for anything but a continuous future's daily bars.
   */
  note: string | null;
}

const MONTH_CODES = "FGHJKMNQUVXZ";
const DAY_MS = 86_400_000;

/**
 * When a root's front contract stops trading, from the exchange's rule, for
 * the roots whose continuous series (NG=F) rolls on the session after it:
 * - `month-start`: the nth session before the delivery month's first day
 *   (Henry Hub gas: three; its E-mini and micro one session earlier);
 * - `before-25th`: the nth session before the 25th of the month before
 *   delivery, one more when the 25th is no session (WTI crude: three);
 * - `month-end`: the last session of the month that many months before
 *   delivery (heating oil and RBOB one, Brent last day two).
 * Sessions are the series' own bars, so a holiday is skipped as the exchange
 * skips it. Checked against NG=F, QG=F, CL=F, HO=F, RB=F and BZ=F daily bars
 * from 2021 to 2026: the session after each last trade is where their rolls
 * show (NG=F's largest moves on it, 8.9% a day on average against 3.7%).
 */
type LastTradeRule =
  | { kind: "month-start"; sessions: number }
  | { kind: "before-25th"; sessions: number }
  | { kind: "month-end"; monthsBefore: number };

const LAST_TRADE_RULES: Readonly<Record<string, LastTradeRule>> = {
  NG: { kind: "month-start", sessions: 3 },
  HH: { kind: "month-start", sessions: 3 },
  QG: { kind: "month-start", sessions: 4 },
  MNG: { kind: "month-start", sessions: 4 },
  CL: { kind: "before-25th", sessions: 3 },
  HO: { kind: "month-end", monthsBefore: 1 },
  RB: { kind: "month-end", monthsBefore: 1 },
  BZ: { kind: "month-end", monthsBefore: 2 },
};

/** The root of a continuous future's symbol (NG of NG=F), or null for anything else. */
function continuousRoot(symbol: string): string | null {
  return /^([A-Z0-9]{1,6})=F$/.exec(symbol.trim().toUpperCase().split(":")[0]!)?.[1] ?? null;
}

/** Whether a symbol is a continuous future's (NG=F), whose returns rollAdjustedHistory reads within one contract. */
export function isContinuousFuture(symbol: string): boolean {
  return continuousRoot(symbol) != null;
}

const monthIndex = (day: string) => Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1;
const monthDay = (index: number, day: number) =>
  `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const contractCode = (root: string, delivery: number) =>
  `${root}${MONTH_CODES[delivery % 12]}${String(Math.floor(delivery / 12) % 100).padStart(2, "0")}`;

/** The index of the first of the ascending `days` on or after `day`; `days.length` when none is. */
function firstOnOrAfter(days: readonly string[], day: string): number {
  let low = 0, high = days.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (days[middle]! < day) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * The rolls the contract calendar puts in `days` (ascending session dates):
 * for each delivery month, the session after its last trade, from the
 * contract delivered that month to the next. A last trade the sessions do not
 * reach past is left out: the series has not shown it yet.
 */
function calendarRolls(root: string, rule: LastTradeRule, days: readonly string[]): Array<{ index: number; from: string; to: string }> {
  if (days.length < 2) return [];
  const rolls: Array<{ index: number; from: string; to: string }> = [];
  for (let month = monthIndex(days[0]!); month <= monthIndex(days.at(-1)!); month++) {
    // The month the last trade falls in, and the delivery month of the contract that stops.
    let last: number;
    let delivery: number;
    if (rule.kind === "month-start") {
      delivery = month + 1;
      const anchor = firstOnOrAfter(days, monthDay(delivery, 1));
      if (anchor >= days.length) continue;
      last = anchor - rule.sessions;
    } else if (rule.kind === "before-25th") {
      delivery = month + 1;
      const target = monthDay(month, 25);
      const anchor = firstOnOrAfter(days, target);
      if (anchor >= days.length) continue;
      last = anchor - rule.sessions - (days[anchor] === target ? 0 : 1);
    } else {
      delivery = month + rule.monthsBefore;
      const anchor = firstOnOrAfter(days, monthDay(month + 1, 1));
      if (anchor >= days.length) continue;
      last = anchor - 1;
    }
    if (last < 0 || last + 1 >= days.length) continue;
    rolls.push({ index: last + 1, from: contractCode(root, delivery), to: contractCode(root, delivery + 1) });
  }
  return rolls;
}

/** The median days between bars: daily bars sit one to three days apart. */
function dailyBars(times: readonly number[]): boolean {
  if (times.length < 2) return false;
  const gaps = times.slice(1).map((time, index) => time - times[index]!).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)]!;
  return median >= 0.5 * DAY_MS && median <= 4 * DAY_MS;
}

const positive = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * A continuous future's daily bars (NG=F) as one series of returns: at every
 * roll, the prices before it are scaled so that the roll day's return is the
 * incoming contract's own, from the roll bar's open (that contract's first
 * trade of the session) to its close, where a front-month series would read
 * the gap between two contracts as a move (NG=F's 26 Oct 2026 roll from
 * NGX26 to NGZ26 as +13.5%). A roll bar without an open is a flat day. Rolls
 * are where the bars change contract; before the bars name one, where the
 * contract calendar (LAST_TRADE_RULES) puts them, for the roots it has. The
 * newest contract's prices are as traded. Anything but a continuous future's
 * daily bars is returned as served, with no note.
 *
 * Every return-based function reads a continuous future through this
 * (volatility, beta and correlation, Kelly sizing, seasonality, backtests);
 * charts and `history` keep the prices as traded.
 */
export function rollAdjustedHistory(points: readonly PricePoint[], symbol: string): RollAdjustedHistory {
  const root = continuousRoot(symbol);
  const timed = points.map((point) => ({ point, time: getPricePointTimestamp(point) }));
  if (!root || timed.some(({ time }) => !Number.isFinite(time))) return { points: [...points], rolls: [], note: null };
  timed.sort((left, right) => left.time - right.time);
  const sorted = timed.map(({ point }) => point);
  if (!dailyBars(timed.map(({ time }) => time))) return { points: sorted, rolls: [], note: null };
  const days = timed.map(({ time }) => new Date(time).toISOString().slice(0, 10));

  const firstNamed = sorted.findIndex((point) => !!point.contract);
  const unnamedEnd = firstNamed < 0 ? sorted.length : firstNamed;
  const found: Array<{ index: number; from: string; to: string; source: ReturnRoll["source"] }> = [];
  const rule = LAST_TRADE_RULES[root];
  if (rule && unnamedEnd > 0) {
    const calendar = calendarRolls(root, rule, days);
    for (const roll of calendar) if (roll.index < unnamedEnd) found.push({ ...roll, source: "calendar" });
    // The bars may start naming a contract other than the one the calendar holds then: the series rolled there.
    const held = calendar.filter((roll) => roll.index < unnamedEnd).at(-1)?.to
      ?? calendar.find((roll) => roll.index >= unnamedEnd)?.from;
    const named = sorted[firstNamed]?.contract;
    if (firstNamed > 0 && held && named && held !== named) found.push({ index: firstNamed, from: held, to: named, source: "bars" });
  }
  let contract: string | null = null;
  for (let index = Math.max(0, firstNamed); firstNamed >= 0 && index < sorted.length; index++) {
    const own = sorted[index]!.contract;
    if (own && contract && own !== contract) found.push({ index, from: contract, to: own, source: "bars" });
    if (own) contract = own;
  }

  // Each roll's factor: the roll bar's open over the close before it, or 1 (flat) on that day where there is none.
  const rolls: ReturnRoll[] = [];
  const factors: Array<{ index: number; factor: number }> = [];
  for (const roll of found.sort((left, right) => left.index - right.index)) {
    const bar = sorted[roll.index]!;
    let before = roll.index - 1;
    while (before >= 0 && !positive(sorted[before]!.close)) before--;
    if (before < 0 || !positive(bar.close)) continue;
    const open = positive(bar.open) && !pricePointOpenWithheld(bar) ? bar.open : null;
    const factor = (open ?? bar.close) / sorted[before]!.close;
    rolls.push({ date: days[roll.index]!, from: roll.from, to: roll.to, source: roll.source, basis: open != null ? "open" : "flat" });
    factors.push({ index: roll.index, factor });
  }

  // Newest first: each roll scales every price before it, on top of the rolls after it.
  let scale = 1;
  let next = factors.length - 1;
  const adjusted = new Array<PricePoint>(sorted.length);
  for (let index = sorted.length - 1; index >= 0; index--) {
    while (next >= 0 && index < factors[next]!.index) scale *= factors[next--]!.factor;
    const point = sorted[index]!;
    const move = (price: number | undefined) => typeof price === "number" ? price * scale : price;
    adjusted[index] = scale === 1 ? point
      : { ...point, open: move(point.open), high: move(point.high), low: move(point.low), close: point.close * scale };
  }
  const note = rule || firstNamed === 0 ? ROLLS_BACK_ADJUSTED
    : firstNamed > 0 ? `${ROLLS_BACK_ADJUSTED} from ${days[firstNamed]}` : ROLLS_LEFT_AS_TRADED;
  return { points: adjusted, rolls, note };
}
