// Alerts on a move from the previous close (`alerts add GBPUSD=X moves 0.5%`,
// `up 3%`, `down 3%`): the day's change the quote reports, measured from the
// close its change line names, for any listing or currency pair. One goes off
// once per session and arms itself again for the next one.
import { changeBasisLabel, quoteChangeBasis, type QuoteChangeBasis } from "../../../market-data/market/change-basis";
import { getActiveQuoteDisplay } from "../../../market-data/market/status";
import type { Quote } from "../../../types/financials";
import type { AlertCondition, AlertRule } from "./types";

/**
 * Move rules keep a synced list of their own: an app or a Gloom Cloud that
 * reads `alerts` would judge `up 3` as a price above 3. Only the running app
 * checks them.
 */
export const MOVE_ALERTS_KEY = "moveAlerts";

/** The words a move is typed with, and the condition each keeps: either way, up, or down. */
const MOVE_WORDS: Readonly<Record<string, AlertCondition>> = {
  moves: "crosses", move: "crosses", up: "above", rises: "above", down: "below", falls: "below",
};

/** The condition a move word names (`moves`, `up`, `down`), or null for any other word. */
export function moveCondition(word: string | undefined): AlertCondition | null {
  return word ? MOVE_WORDS[word.toLowerCase()] ?? null : null;
}

/** The largest move a rule takes, in percent: a fall cannot pass 100%. */
export const MAX_MOVE_PERCENT = 100;

/** `0.5%`, `3`, `+3%`: a move in percent, unsigned; null when it is no positive number up to 100. */
export function parseMovePercent(text: string | undefined): number | null {
  const match = /^\+?(\d+(?:\.\d+)?|\.\d+)\s*%?$/.exec(text?.trim() ?? "");
  const value = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(value) && value > 0 && value <= MAX_MOVE_PERCENT ? value : null;
}

/** Whether a level rule is a move from the previous close. */
export const isMoveAlert = (alert: Pick<AlertRule, "move">): boolean => alert.move === true;

const percentText = (value: number) => `${Number(value.toFixed(2)).toFixed(2)}%`;

/** `±0.50%`, `+3.00%`, `-3.00%`: a move rule's target, signed by its direction. */
export function moveTargetText(alert: Pick<AlertRule, "condition" | "targetPrice">): string {
  const sign = alert.condition === "crosses" ? "±" : alert.condition === "above" ? "+" : "-";
  return `${sign}${percentText(alert.targetPrice)}`;
}

/** `-0.38%`, `+1.20%`: a move as read, signed; `0.00%` unsigned. */
export function movePercentText(value: number): string {
  const text = percentText(Math.abs(value));
  return /[1-9]/.test(text) ? `${value > 0 ? "+" : "-"}${text}` : text;
}

/** `moves 0.50%`, `up 3.00%`, `down 3.00%`: the rule in the words `alerts add` takes. */
export function moveRuleWords(alert: Pick<AlertRule, "condition" | "targetPrice">): string {
  const word = alert.condition === "crosses" ? "moves" : alert.condition === "above" ? "up" : "down";
  return `${word} ${percentText(alert.targetPrice)}`;
}

/** The Trigger column's word: Moves, Up or Down. */
export function moveTriggerLabel(condition: AlertCondition): string {
  return condition === "crosses" ? "Moves" : condition === "above" ? "Up" : "Down";
}

/** What a move is measured from, as the quote's change line names it: `vs Thu 5 Nov close`, `vs prev close`. */
export function moveBasisText(basis: QuoteChangeBasis | null | undefined, now = Date.now()): string {
  return basis ? changeBasisLabel(basis, now) : "vs prev close";
}

/** A move as a quote reports it: the percent, what it is measured from, and the session it belongs to. */
export interface MoveReading {
  percent: number;
  basis: QuoteChangeBasis;
  /**
   * The session the move is of, named by the close it is measured from (the
   * 2026-11-05 close); a rule that went off in one arms again in the next.
   */
  session: string;
}

const utcDay = (time: number) => new Date(time).toISOString().slice(0, 10);

/**
 * The move a quote reports for a rule to judge: its change percent (the
 * latest print's, extended hours included, as the alert's price is) and the
 * close it is measured from. A coin's move from 00:00 UTC is that day's, one
 * over 24 hours the UTC day's. Null for a quote with no move.
 */
export function readMove(quote: Quote, now = Date.now()): MoveReading | null {
  const percent = getActiveQuoteDisplay(quote)?.changePercent ?? quote.changePercent;
  if (!Number.isFinite(percent)) return null;
  const basis = quoteChangeBasis(quote, { session: "active" });
  if (!basis) return null;
  const session = "date" in basis ? basis.date
    : basis.kind === "previous close" ? `close:${quote.previousClose ?? ""}`
    : utcDay(now);
  return { percent, basis, session };
}

/** Whether a move reaches a rule: either way by its size, or up or down by it. */
export function moveReached(alert: Pick<AlertRule, "condition" | "targetPrice">, percent: number): boolean {
  // To the hundredth of a percent the quote prints, so a 0.4999% move is not 0.50%.
  const move = Math.round(percent * 100) / 100;
  if (alert.condition === "above") return move >= alert.targetPrice;
  if (alert.condition === "below") return move <= -alert.targetPrice;
  return Math.abs(move) >= alert.targetPrice;
}

/**
 * A move rule judged on a quote. One that went off in an earlier session is
 * armed again first; then it goes off when the move reaches it, once for the
 * session. Returns the rule with its reading, and whether it went off now.
 */
export function judgeMove(alert: AlertRule, quote: Quote, now = Date.now()): { alert: AlertRule; fired: boolean; reading: MoveReading | null } {
  const reading = readMove(quote, now);
  if (!reading) return { alert, fired: false, reading };
  let next: AlertRule = { ...alert, lastCheckedPrice: reading.percent, lastMoveBasis: reading.basis };
  // Armed again for a new session: `triggeredAt` is cleared rather than left out, so it clears on a rule merged into.
  if (next.status === "triggered" && next.moveSession !== reading.session) next = { ...next, status: "active", triggeredAt: undefined };
  const fired = next.status === "active" && next.moveSession !== reading.session && moveReached(next, reading.percent);
  if (fired) next = { ...next, status: "triggered", triggeredAt: now, moveSession: reading.session };
  return { alert: next, fired, reading };
}

/** "GBPUSD=X moved -0.52% vs Thu 5 Nov close, at 1.33702": the notification of a move rule that went off. */
export function moveFiredText(listing: string, reading: MoveReading, price: string, now = Date.now()): string {
  return `${listing} moved ${movePercentText(reading.percent)} ${moveBasisText(reading.basis, now)}, at ${price}`;
}
