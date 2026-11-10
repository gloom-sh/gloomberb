import { toBasisPoints } from "./basis-points";

/**
 * The largest fall from a close to a later close (docs/usage.md, under `history`):
 * the peak it fell from and the trough it reached, each with its date, the
 * fall as a fraction of the peak, and the first later close back at the peak,
 * if any. Read off closes, as returns are; a missing or non-positive close is
 * passed over. The earliest of equal falls is the one named.
 *
 * A series in yield units (^TNX, a yield in percent) falls and rises by its
 * level: the largest fall in percentage points, said in basis points (`bp`),
 * and its largest rise as well (`maxRunUp`). A ratio of two yields is no
 * move anyone reads.
 */
export interface MaxDrawdown {
  peak: { date: string; close: number };
  trough: { date: string; close: number };
  /** trough / peak - 1: 0 when no close fell below an earlier one, else negative. */
  drawdown: number;
  /** A yield's fall, trough - peak in basis points to a tenth; absent for a price. */
  bp?: number;
  /** The first date after the trough whose close is back at the peak; null when none is in the series. */
  recovered: string | null;
  /** The last date in the series, which a fall not yet recovered is measured to. */
  through: string;
}

/** A yield's largest rise from a close to a later close: the low it rose from and the high it reached. */
export interface MaxRunUp {
  low: { date: string; close: number };
  high: { date: string; close: number };
  /** high - low in basis points, to a tenth: 0 when no close rose above an earlier one. */
  bp: number;
  /** The first date after the high whose close is back at the low; null when none is in the series. */
  recovered: string | null;
  through: string;
}

/** How a series moves: a price by its return, a yield in percent by its level. */
export type DrawdownScale = "return" | "yield";

interface ClosePoint {
  /** An ISO date or instant; points sort by it. */
  date: string;
  close: number | null | undefined;
}

function sortedCloses(points: readonly ClosePoint[], scale: DrawdownScale) {
  // A yield can sit at or below zero; a price there is no close.
  return points
    .filter((point): point is { date: string; close: number } => typeof point.close === "number" && Number.isFinite(point.close)
      && (scale === "yield" || point.close > 0))
    .toSorted((left, right) => left.date.localeCompare(right.date));
}

/** The series' max drawdown, or null with fewer than two closes. */
export function maxDrawdown(points: readonly ClosePoint[], scale: DrawdownScale = "return"): MaxDrawdown | null {
  const closes = sortedCloses(points, scale);
  if (closes.length < 2) return null;
  const fallOf = (from: number, to: number) => scale === "yield" ? to - from : to / from - 1;
  let peak = closes[0]!;
  let worst = { peak, trough: peak, fall: 0 };
  for (const point of closes) {
    if (point.close > peak.close) peak = point;
    const fall = fallOf(peak.close, point.close);
    if (fall < worst.fall) worst = { peak, trough: point, fall };
  }
  const recovered = worst.fall < 0
    ? closes.find((point) => point.date > worst.trough.date && point.close >= worst.peak.close)?.date ?? null
    : null;
  return {
    peak: { date: worst.peak.date, close: worst.peak.close },
    trough: { date: worst.trough.date, close: worst.trough.close },
    drawdown: scale === "yield" ? (worst.peak.close > 0 ? worst.trough.close / worst.peak.close - 1 : 0) : worst.fall,
    ...(scale === "yield" ? { bp: toBasisPoints(worst.fall, 1) } : {}),
    recovered,
    through: closes.at(-1)!.date,
  };
}

/** A yield series' largest rise from a close to a later close, or null with fewer than two closes. */
export function maxRunUp(points: readonly ClosePoint[]): MaxRunUp | null {
  const closes = sortedCloses(points, "yield");
  if (closes.length < 2) return null;
  let low = closes[0]!;
  let best = { low, high: low, rise: 0 };
  for (const point of closes) {
    if (point.close < low.close) low = point;
    const rise = point.close - low.close;
    if (rise > best.rise) best = { low, high: point, rise };
  }
  const recovered = best.rise > 0
    ? closes.find((point) => point.date > best.high.date && point.close <= best.low.close)?.date ?? null
    : null;
  return {
    low: { date: best.low.date, close: best.low.close },
    high: { date: best.high.date, close: best.high.close },
    bp: toBasisPoints(best.rise, 1),
    recovered,
    through: closes.at(-1)!.date,
  };
}

interface MoveTextOptions { basis: string; price: (value: number) => string; date?: (text: string) => string }

/** Whole basis points, signed; a move that rounds to nothing is still a move, which 0bp would hide. */
function bpText(bp: number): string {
  const whole = Math.round(bp);
  if (whole === 0) return bp === 0 ? "0bp" : "under 1bp";
  return `${whole > 0 ? "+" : ""}${whole}bp`;
}

/**
 * The report line: `Max drawdown -69.6% (daily closes): peak 53.25 on 2007-05-30, trough 16.19 on 2009-03-09,
 * not back to the peak by 2009-12-31`; a yield's fall in bp: `Max drawdown -16bp (daily closes): ...`.
 * `price` and `date` draw a close and a date as the table does.
 */
export function maxDrawdownText(value: MaxDrawdown, { basis, price, date = (text) => text.slice(0, 10) }: MoveTextOptions): string {
  const percent = (value.drawdown * 100).toFixed(1);
  // A fall that rounds to nothing is still a fall, which -0.0% would hide.
  const size = value.bp != null ? bpText(value.bp) : percent === "-0.0" ? "under 0.1%" : `${percent}%`;
  const head = `Max drawdown ${size} (${basis})`;
  if (value.peak.date === value.trough.date) return `${head}: no close fell below an earlier one`;
  const back = value.recovered ? `back to the peak on ${date(value.recovered)}` : `not back to the peak by ${date(value.through)}`;
  return `${head}: peak ${price(value.peak.close)} on ${date(value.peak.date)}, trough ${price(value.trough.close)} on ${date(value.trough.date)}, ${back}`;
}

/** `Max run-up +45bp (daily closes): low 3.998 on 2025-11-26, high 4.448 on 2026-01-14, not back to the low by 2026-02-02`. */
export function maxRunUpText(value: MaxRunUp, { basis, price, date = (text) => text.slice(0, 10) }: MoveTextOptions): string {
  const head = `Max run-up ${bpText(value.bp)} (${basis})`;
  if (value.low.date === value.high.date) return `${head}: no close rose above an earlier one`;
  const back = value.recovered ? `back to the low on ${date(value.recovered)}` : `not back to the low by ${date(value.through)}`;
  return `${head}: low ${price(value.low.close)} on ${date(value.low.date)}, high ${price(value.high.close)} on ${date(value.high.date)}, ${back}`;
}

/**
 * A move measured to no later than `until` (`YYYY-MM-DD`, the last day asked
 * for): a window's last weekly bar can close after it (`--to 2003` ends on
 * Wed 31 Dec, that bar's week on Fri 2 Jan), and a week still forming runs to
 * today, so "not back to the peak by" names the end asked for, never a later
 * day. Never earlier than a date the move names. The move as it is without
 * `until`, or when it ends in time.
 */
export function measuredUntil<Move extends MaxDrawdown | MaxRunUp>(move: Move, until: string | null | undefined): Move {
  const through = move.through.slice(0, 10);
  if (!until || through <= until) return move;
  const named = "peak" in move ? [move.peak.date, move.trough.date] : [move.low.date, move.high.date];
  const end = named.map((date) => date.slice(0, 10)).reduce((last, date) => date > last ? date : last, until);
  return end >= through ? move : { ...move, through: end };
}

/**
 * A series' largest fall, and a yield's largest rise as well, with the lines a
 * report says them in, each measured to no later than `until` (`measuredUntil`).
 */
export function closeMoves(points: readonly ClosePoint[], scale: DrawdownScale, text: MoveTextOptions, until?: string | null): {
  drawdown: MaxDrawdown | null;
  runUp: MaxRunUp | null;
  lines: string[];
} {
  const fell = maxDrawdown(points, scale);
  const rose = scale === "yield" ? maxRunUp(points) : null;
  const drawdown = fell && measuredUntil(fell, until);
  const runUp = rose && measuredUntil(rose, until);
  return { drawdown, runUp, lines: [...drawdown ? [maxDrawdownText(drawdown, text)] : [], ...runUp ? [maxRunUpText(runUp, text)] : []] };
}
