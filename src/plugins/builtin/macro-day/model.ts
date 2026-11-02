import type { EarningsTiming } from "../../../api-client/earnings";
import type { PricePoint } from "../../../types/financials";
import { zonedDateTimeParts } from "../../../utils/zoned-date-time";
import { toBasisPoints } from "../../../utils/basis-points";
import { isYieldIndexSymbol } from "../../../tickers/index-roots";
import { MACRO_EVENT_KINDS, MACRO_EVENT_LABELS, US_MACRO_EVENT_KINDS, type MacroEventKind, type MacroRelease, type MacroReleaseFigures,
  type MacroSurprise } from "./releases";

const DAY_MS = 86_400_000;
/** Longest calendar gap between two closes that is still one session apart: Thursday to Monday over a Friday holiday. */
const MAX_SESSION_GAP_DAYS = 4;

/** One of the ticker's own earnings reports, reduced to what dates its reaction. */
export interface MacroDayEarningsReport {
  /** Report date, New York. */
  date: string;
  timing: EarningsTiming | null;
  /** The session the earnings history measures the report's move on, once the report is priced. */
  reactionSession?: string | null;
}

/**
 * How a day's move is measured: a price's return, or for a yield (^TNX, whose
 * level is the yield in percent) the change in that yield, in percentage
 * points, which the pane and the report read in basis points.
 */
export type MacroDayMoveBasis = "return" | "yield";

/** A Treasury yield index moves by its level: 5.24 to 5.28 is +4bp, not +0.76%. */
const macroDayMoveBasis = (symbol: string): MacroDayMoveBasis => isYieldIndexSymbol(symbol) ? "yield" : "return";

/**
 * A move as it reads: a return in percent (`+0.76%`), a yield's change in
 * basis points (`+4.0bp`, or `+4.0` under a column headed bp). One that
 * rounds to zero is unsigned.
 */
export function formatMacroDayMove(value: number | null | undefined, basis: MacroDayMoveBasis,
  { signed = true, unit = true }: { signed?: boolean; unit?: boolean } = {}): string {
  if (value == null) return "--";
  if (basis === "yield") {
    const bp = toBasisPoints(value, 1);
    return `${signed && bp > 0 ? "+" : ""}${bp.toFixed(1)}${unit ? "bp" : ""}`;
  }
  const fixed = (value * 100).toFixed(2);
  return /[1-9]/.test(fixed) ? `${signed && value > 0 ? "+" : ""}${fixed}%` : "0.00%";
}

/** The decimals a move shows in hundredths (percent of a return, basis points of a yield), for its sign and colour. */
export const macroDayMoveDecimals = (basis: MacroDayMoveBasis) => basis === "yield" ? 1 : 2;

export interface MacroDayEvent {
  kind: MacroEventKind;
  /** Release day, New York date. */
  date: string;
  /** The session whose close carries the reaction: the release day, or the next session when the market was shut. */
  session: string;
  /** The session is also the reaction session of the ticker's own earnings report: the move is the report's, not the release's. */
  earnings: boolean;
  /** Close before the release to the session's close: a return, or a yield's change in percentage points (`basis`). */
  move: number;
  /** |move| over the normal day's average |move|. */
  multiple: number | null;
  /** What the release came out with, when the list has it. */
  figures: MacroReleaseFigures | null;
}

export interface MacroDayStats {
  count: number;
  meanAbs: number | null;
  mean: number | null;
  /** Share of days that closed up. */
  hitRate: number | null;
  /** meanAbs over the normal day's. */
  multiple: number | null;
}

export interface MacroDayModel {
  symbol: string;
  basis: MacroDayMoveBasis;
  /** Newest first. */
  events: MacroDayEvent[];
  /** The kinds the list carries: the US releases, and IPCA when Gloom Cloud lists its days. */
  kinds: MacroEventKind[];
  /** Without the earnings days. */
  byKind: Record<MacroEventKind, MacroDayStats>;
  /**
   * Every US release day together, without the earnings days; a day with two
   * releases counts once. IPCA days are summed up on their own only, so a US
   * name's figures do not move with Brazil's calendar.
   */
  allEvents: MacroDayStats;
  /** US release days that are the ticker's earnings reaction, which no other figure counts; a day with two releases counts once. */
  earnings: MacroDayStats;
  /** Sessions with no US release, and none of the earnings days among them. */
  normal: MacroDayStats;
  start: string | null;
  asOf: string | null;
}

/** The release's name, with the earnings marker on a day that is the ticker's own report reaction. */
export const macroDayEventLabel = (event: Pick<MacroDayEvent, "kind" | "earnings">) =>
  event.earnings ? `${MACRO_EVENT_LABELS[event.kind]} (earnings)` : MACRO_EVENT_LABELS[event.kind];

/** Daily labels at UTC midnight name that date; any other stamp reads in New York. */
function sessionDate(time: number): string {
  if (time % DAY_MS === 0) return new Date(time).toISOString().slice(0, 10);
  const { year, month, day } = zonedDateTimeParts(time, "America/New_York");
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
const isWeekday = (date: string) => { const day = new Date(`${date}T00:00:00Z`).getUTCDay(); return day > 0 && day < 6; };

/** The figures over some of the model's release days (the hot CPI days): their moves, the earnings days left out as the kinds' are. */
export function macroDayStats(events: readonly MacroDayEvent[], normalAbs: number | null): MacroDayStats {
  return stats(events.filter((event) => !event.earnings).map((event) => event.move), normalAbs);
}

/** Whether a release day's print matches a surprise filter; `all` matches every day, figures or not. */
export const matchesSurprise = (event: Pick<MacroDayEvent, "figures">, surprise: MacroSurprise | "all") =>
  surprise === "all" || event.figures?.surprise === surprise;

function stats(moves: number[], normalAbs: number | null): MacroDayStats {
  if (!moves.length) return { count: 0, meanAbs: null, mean: null, hitRate: null, multiple: null };
  const meanAbs = moves.reduce((sum, move) => sum + Math.abs(move), 0) / moves.length;
  return { count: moves.length, meanAbs, mean: moves.reduce((sum, move) => sum + move, 0) / moves.length,
    hitRate: moves.filter((move) => move > 0).length / moves.length,
    multiple: normalAbs ? meanAbs / normalAbs : null };
}

/**
 * The sessions whose close carries a report's reaction, on the history's own
 * calendar. A priced report names its session in the earnings history. Any
 * other reads as the earnings history reads it: before the open and during
 * the session react the same day, after the close the next session. A report
 * with no time on record may have reacted on either, so both count.
 */
function earningsReactionSessions(reports: readonly MacroDayEarningsReport[], sessions: readonly string[]): Set<string> {
  const reacted = new Set<string>();
  for (const report of reports) {
    if (report.reactionSession) { reacted.add(report.reactionSession); continue; }
    const sameDay = report.timing === "bmo" || report.timing === "dmh";
    const afterClose = report.timing === "amc";
    const same = sessions.find((date) => date >= report.date);
    const next = sessions.find((date) => date > report.date);
    if (!afterClose && same) reacted.add(same);
    if (!sameDay && next) reacted.add(next);
  }
  return reacted;
}

const US_KINDS: ReadonlySet<MacroEventKind> = new Set(US_MACRO_EVENT_KINDS);

/**
 * Close to close on the release day: 8:30 ET releases land before the open
 * and 14:00 FOMC statements before the close, so the release day's close
 * carries either. A release on a weekday the market was shut (Good Friday)
 * is read on the next session, from the close before the release. A release
 * whose close-to-close would span a gap in the history is left out rather
 * than read across it. A lone missing bar on the release day itself cannot
 * be told from a holiday and is read on the next session. A release whose
 * session is also the reaction to the ticker's own earnings is kept, marked,
 * and counted in neither the release figures nor the normal days.
 */
export function projectMacroDays(history: readonly PricePoint[], options: {
  symbol: string;
  /** How a move is measured when the symbol does not say: a FRED rate or spread moves by its level, in bp. */
  basis?: MacroDayMoveBasis;
  lookbackYears: number;
  releases: readonly MacroRelease[];
  /** The release list's last covered day. */
  coveredThrough: string;
  /** The ticker's own earnings reports; none when they could not be read. */
  earnings?: readonly MacroDayEarningsReport[];
}): MacroDayModel {
  const { coveredThrough } = options;
  const basis = options.basis ?? macroDayMoveBasis(options.symbol);
  const byDate = new Map<string, number>();
  for (const point of history) {
    const time = new Date(point.date).getTime();
    // A yield can sit at zero or below it; a price cannot.
    if (!Number.isFinite(time) || !Number.isFinite(point.close) || (basis === "return" && point.close <= 0)) continue;
    byDate.set(sessionDate(time), point.close);
  }
  const sessions = [...byDate.keys()].sort();
  const last = sessions.at(-1) ?? null;
  const empty = (): MacroDayStats => stats([], null);
  const kinds = MACRO_EVENT_KINDS.filter((kind) => US_KINDS.has(kind) || options.releases.some((release) => release.kind === kind));
  if (!last) return { symbol: options.symbol, basis, events: [], kinds, byKind: { cpi: empty(), jobs: empty(), fomc: empty(), ipca: empty() },
    allEvents: empty(), earnings: empty(), normal: empty(), start: null, asOf: null };

  // Sessions after the published lists end may be unlisted release days, so they are left out of both sides.
  const end = last < coveredThrough ? last : coveredThrough;
  const startYear = Number(end.slice(0, 4)) - Math.max(1, options.lookbackYears);
  const nominalStart = `${startYear}${end.slice(4)}`;
  // The history can begin after the nominal start (daily bars reach back five years from today, the list's end is older).
  // The first bar has no close before it, so the window opens there: a release before it falls outside the stated start.
  const firstSession = sessions[0]!;
  const start = firstSession > nominalStart ? firstSession : nominalStart;
  /** Session date -> close-to-close move from the session before, when the two are one session apart. */
  const moves = new Map<string, number>();
  for (let index = 1; index < sessions.length; index++) {
    const date = sessions[index]!, previous = sessions[index - 1]!;
    if (date <= start || date > end || dayNumber(date) - dayNumber(previous) > MAX_SESSION_GAP_DAYS) continue;
    moves.set(date, basis === "yield" ? byDate.get(date)! - byDate.get(previous)! : byDate.get(date)! / byDate.get(previous)! - 1);
  }

  const reactionSessions = new Set<string>();
  const found: Omit<MacroDayEvent, "multiple" | "earnings">[] = [];
  for (const release of options.releases) {
    if (release.date <= start || release.date > end || !isWeekday(release.date)) continue;
    const at = sessions.findIndex((date) => date >= release.date);
    if (at < 1) continue;
    const session = sessions[at]!;
    const move = moves.get(session);
    if (move == null || (session !== release.date && skipsAnotherWeekday(release.date, sessions[at - 1]!, session))) continue;
    if (US_KINDS.has(release.kind)) reactionSessions.add(session);
    found.push({ kind: release.kind, date: release.date, session, move, figures: release.figures ?? null });
  }

  const normalMoves = [...moves].filter(([date]) => !reactionSessions.has(date)).map(([, move]) => move);
  const normal = stats(normalMoves, null);
  const normalAbs = normal.meanAbs;
  const reacted = earningsReactionSessions(options.earnings ?? [], sessions);
  const events = found.map((event) => ({ ...event, earnings: reacted.has(event.session), multiple: normalAbs ? Math.abs(event.move) / normalAbs : null }))
    .sort((left, right) => right.date.localeCompare(left.date) || left.kind.localeCompare(right.kind));
  const byKind = Object.fromEntries(MACRO_EVENT_KINDS.map((kind) =>
    [kind, stats(events.filter((event) => event.kind === kind && !event.earnings).map((event) => event.move), normalAbs)])) as Record<MacroEventKind, MacroDayStats>;
  const sessionMoves = (flagged: boolean) => [...reactionSessions].filter((session) => reacted.has(session) === flagged).map((session) => moves.get(session)!);
  return { symbol: options.symbol, basis, events, kinds, byKind, allEvents: stats(sessionMoves(false), normalAbs), earnings: stats(sessionMoves(true), normalAbs),
    normal, start, asOf: end };
}

/**
 * A release weekday with no close of its own reads as a holiday only when the
 * closes either side have nothing but it and a weekend between them; any other
 * weekday between them is a gap in the data, and the move would span it.
 */
function skipsAnotherWeekday(release: string, previous: string, next: string): boolean {
  for (let day = dayNumber(previous) + 1; day < dayNumber(next); day++) {
    const date = new Date(day * DAY_MS).toISOString().slice(0, 10);
    if (date !== release && isWeekday(date)) return true;
  }
  return false;
}
