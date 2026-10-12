import type { EarningsTiming } from "../../../api-client/earnings";
import type { PricePoint } from "../../../types/financials";
import { zonedDateTimeParts } from "../../../utils/zoned-date-time";
import { MACRO_EVENT_KINDS, MACRO_EVENT_LABELS, type MacroEventKind, type MacroRelease } from "./releases";

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

export interface MacroDayEvent {
  kind: MacroEventKind;
  /** Release day, New York date. */
  date: string;
  /** The session whose close carries the reaction: the release day, or the next session when the market was shut. */
  session: string;
  /** The session is also the reaction session of the ticker's own earnings report: the move is the report's, not the release's. */
  earnings: boolean;
  /** Close before the release to the session's close. */
  move: number;
  /** |move| over the normal day's average |move|. */
  multiple: number | null;
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
  /** Newest first. */
  events: MacroDayEvent[];
  /** Without the earnings days. */
  byKind: Record<MacroEventKind, MacroDayStats>;
  /** Every release day of the three kinds together, without the earnings days; a day with two releases counts once. */
  allEvents: MacroDayStats;
  /** Release days that are the ticker's earnings reaction, which no other figure counts; a day with two releases counts once. */
  earnings: MacroDayStats;
  /** Sessions with no release of the three kinds, and none of the earnings days among them. */
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
  lookbackYears: number;
  releases: readonly MacroRelease[];
  /** The release list's last covered day. */
  coveredThrough: string;
  /** The ticker's own earnings reports; none when they could not be read. */
  earnings?: readonly MacroDayEarningsReport[];
}): MacroDayModel {
  const { coveredThrough } = options;
  const byDate = new Map<string, number>();
  for (const point of history) {
    const time = new Date(point.date).getTime();
    if (!Number.isFinite(time) || !Number.isFinite(point.close) || point.close <= 0) continue;
    byDate.set(sessionDate(time), point.close);
  }
  const sessions = [...byDate.keys()].sort();
  const last = sessions.at(-1) ?? null;
  const empty = (): MacroDayStats => stats([], null);
  if (!last) return { symbol: options.symbol, events: [], byKind: { cpi: empty(), jobs: empty(), fomc: empty() },
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
    moves.set(date, byDate.get(date)! / byDate.get(previous)! - 1);
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
    reactionSessions.add(session);
    found.push({ kind: release.kind, date: release.date, session, move });
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
  return { symbol: options.symbol, events, byKind, allEvents: stats(sessionMoves(false), normalAbs), earnings: stats(sessionMoves(true), normalAbs),
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
