import type { PricePoint } from "../../../types/financials";
import { zonedDateTimeParts } from "../../../utils/zoned-date-time";
import { MACRO_EVENT_KINDS, MACRO_RELEASE_BASIS, macroReleases, type MacroEventKind, type MacroRelease } from "./releases";

const DAY_MS = 86_400_000;
/** Longest calendar gap between two closes that is still one session apart: Thursday to Monday over a Friday holiday. */
const MAX_SESSION_GAP_DAYS = 4;

export interface MacroDayEvent {
  kind: MacroEventKind;
  /** Release day, New York date. */
  date: string;
  /** The session whose close carries the reaction: the release day, or the next session when the market was shut. */
  session: string;
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
  byKind: Record<MacroEventKind, MacroDayStats>;
  /** Every release day of the three kinds together; a day with two releases counts once. */
  allEvents: MacroDayStats;
  /** Sessions with no release of the three kinds. */
  normal: MacroDayStats;
  start: string | null;
  asOf: string | null;
}

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
 * Close to close on the release day: 8:30 ET releases land before the open
 * and 14:00 FOMC statements before the close, so the release day's close
 * carries either. A release on a weekday the market was shut (Good Friday)
 * is read on the next session, from the close before the release. A release
 * whose close-to-close would span a gap in the history is left out rather
 * than read across it. A lone missing bar on the release day itself cannot
 * be told from a holiday and is read on the next session.
 */
export function projectMacroDays(history: readonly PricePoint[], options: {
  symbol: string;
  lookbackYears: number;
  releases?: readonly MacroRelease[];
  coveredThrough?: string;
}): MacroDayModel {
  const coveredThrough = options.coveredThrough ?? MACRO_RELEASE_BASIS.coveredThrough;
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
    allEvents: empty(), normal: empty(), start: null, asOf: null };

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
  const found: Omit<MacroDayEvent, "multiple">[] = [];
  for (const release of options.releases ?? macroReleases()) {
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
  const events = found.map((event) => ({ ...event, multiple: normalAbs ? Math.abs(event.move) / normalAbs : null }))
    .sort((left, right) => right.date.localeCompare(left.date) || left.kind.localeCompare(right.kind));
  const byKind = Object.fromEntries(MACRO_EVENT_KINDS.map((kind) =>
    [kind, stats(events.filter((event) => event.kind === kind).map((event) => event.move), normalAbs)])) as Record<MacroEventKind, MacroDayStats>;
  const allEvents = stats([...reactionSessions].map((session) => moves.get(session)!), normalAbs);
  return { symbol: options.symbol, events, byKind, allEvents, normal, start, asOf: end };
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
