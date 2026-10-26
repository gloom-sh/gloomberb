import { getPublishedUsEquityCalendarDay, getPublishedUsEquitySession } from "../../../market-data/published-us-sessions";
import { zonedDateKey, zonedWallClockToUtcMs } from "../../../utils/zoned-date-time";
import type { MacroEventKind, MacroRelease } from "../macro-day/releases";
import type { DatedValue, IvHistoryModel, IvLookback } from "./model";

/** One release and the readings a set number of sessions from it. */
interface ReleaseOffsetRow {
  kind: MacroEventKind;
  /** The release's New York calendar day. */
  releaseDate: string;
  /** Sessions from the release: 0 is the first session on or after its day, -6 the sixth session before that. */
  offset: number;
  /** The session the readings are of. */
  date: string;
  iv30: number | null;
  iv90: number | null;
  iv365: number | null;
  hv: number | null;
  spread: number | null;
  /** 25-delta put IV minus call IV, and the risk reversal, call minus put. */
  skew25d: number | null;
  rr25d: number | null;
}

export interface ReleaseOffsets {
  rows: ReleaseOffsetRow[];
  /** Releases whose session at the offset has not closed or has no closing reading yet, oldest first. */
  pending: string[];
  /** Releases inside the stored history whose session at the offset is before the lookback. */
  beforeLookback: number;
  /** Releases before the IV history starts. */
  beforeHistory: number;
  /** The first session of the IV history read, when there is one. */
  historyStart: string | null;
}

const NEW_YORK = "America/New_York";
const day = (date: Date) => date.toISOString().slice(0, 10);
const byDay = (points: readonly DatedValue[]) => new Map(points.map((point) => [day(point.date), point.value]));
const nextDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** Whether `date`'s regular session has closed at `now`: an earlier New York day, or today from its close on. */
function sessionClosed(date: string, now: number): boolean {
  const today = zonedDateKey(now, NEW_YORK);
  if (date !== today) return date < today;
  const session = getPublishedUsEquitySession("NYSE", date);
  const [year, month, dayOfMonth] = date.split("-").map(Number) as [number, number, number];
  return now >= (session?.kind === "session" ? session.close : zonedWallClockToUtcMs(NEW_YORK, year, month, dayOfMonth, 16, 0, 0));
}

/** The US equity sessions after `after` through the first on or after `until`; null where the published calendar ends. */
function calendarSessions(after: string, until: string): string[] | null {
  const sessions: string[] = [];
  for (let date = nextDay(after); ; date = nextDay(date)) {
    const kind = getPublishedUsEquityCalendarDay("NYSE", date);
    if (kind == null) return null;
    if (kind !== "session") continue;
    sessions.push(date);
    if (date >= until) return sessions;
  }
}

/**
 * One row per release of `kind`, with the readings on the session `offset`
 * sessions from it (the "week before FOMC" is `-5` or `-6`), oldest first.
 * Offset 0 is the first session on or after the release day, so a release on
 * a day with no session counts from the next one. Sessions are the history's
 * own, from the first IV reading in the lookback through the last closed
 * session read (`readThrough`, or the last IV reading), and past that the
 * published exchange calendar: an upcoming release whose session at a
 * negative offset has closed and been read gets its row. A release whose
 * session at the offset has not closed or has no reading yet is pending; one
 * whose session falls before the history read is counted, before the lookback
 * or before the history.
 */
export function releaseOffsetRows(
  model: Pick<IvHistoryModel, "iv30" | "iv90" | "iv365" | "hv" | "spread" | "skew" | "since">,
  releases: readonly MacroRelease[],
  kind: MacroEventKind,
  offset: number,
  { lookback = "ALL", readThrough = null, now = Date.now() }: { lookback?: IvLookback; readThrough?: string | null; now?: number } = {},
): ReleaseOffsets {
  const result: ReleaseOffsets = { rows: [], pending: [], beforeLookback: 0, beforeHistory: 0, historyStart: null };
  // Sessions from the first IV reading on: realized volatility alone, before it or without it, is no IV row.
  const first = model.iv30[0] ? day(model.iv30[0].date) : null;
  if (!first) return result;
  const lastReading = day(model.iv30.at(-1)!.date);
  const through = readThrough && readThrough > lastReading ? readThrough : lastReading;
  // A session counts once it has closed and been read: today's bar before the close, or a session the IV history has not reached, is no reading.
  const known = [...new Set([...model.iv30, ...model.hv].map((point) => day(point.date)))]
    .filter((session) => session >= first && session <= through && sessionClosed(session, now)).sort();
  if (known.length === 0) return result;
  result.historyStart = known[0]!;
  // The lookback cut a longer stored history: a release before it is outside the lookback, not before the history.
  const trimmed = lookback !== "ALL" && model.since != null && model.since < first;
  const before = (release: MacroRelease) => {
    if (trimmed && release.date >= model.since!) result.beforeLookback += 1;
    else result.beforeHistory += 1;
  };
  const iv30 = byDay(model.iv30), iv90 = byDay(model.iv90), iv365 = byDay(model.iv365);
  const hv = byDay(model.hv), spread = byDay(model.spread), skew = byDay(model.skew);
  for (const release of releases) {
    if (release.kind !== kind) continue;
    if (release.date < known[0]!) {
      before(release);
      continue;
    }
    const anchor = known.findIndex((session) => session >= release.date);
    let index: number;
    if (anchor >= 0) index = anchor + offset;
    else {
      // After the last session read: count on through the exchange calendar to the release's own session.
      const ahead = calendarSessions(known.at(-1)!, release.date);
      if (!ahead) {
        result.pending.push(release.date);
        continue;
      }
      index = known.length + ahead.length - 1 + offset;
    }
    if (index < 0) {
      before(release);
      continue;
    }
    if (index >= known.length) {
      result.pending.push(release.date);
      continue;
    }
    const date = known[index]!;
    const skewValue = skew.get(date) ?? null;
    result.rows.push({
      kind, releaseDate: release.date, offset, date,
      iv30: iv30.get(date) ?? null, iv90: iv90.get(date) ?? null, iv365: iv365.get(date) ?? null,
      hv: hv.get(date) ?? null, spread: spread.get(date) ?? null,
      skew25d: skewValue, rr25d: skewValue == null ? null : -skewValue,
    });
  }
  return result;
}

/** "6 sessions before", "release day", "1 session after". */
export function offsetText(offset: number): string {
  if (offset === 0) return "release day";
  const sessions = `${Math.abs(offset)} session${Math.abs(offset) === 1 ? "" : "s"}`;
  return offset < 0 ? `${sessions} before` : `${sessions} after`;
}
