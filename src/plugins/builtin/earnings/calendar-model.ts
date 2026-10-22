import type { EarningsTiming } from "../../../api-client/earnings";
import { addDays, isSession, ownershipRank, type BoardReport } from "./board-model";
import { shortDate, weekday } from "./format";

/** The weeks the calendar view offers, from the one before this week to three ahead. */
export const CALENDAR_WEEK_OFFSETS = [-1, 0, 1, 2, 3] as const;
export type CalendarWeekOffset = (typeof CALENDAR_WEEK_OFFSETS)[number];

/** Within a day, reports before the open come first, then during the session, after the close, and those with no time yet. */
const SESSIONS: ReadonlyArray<{ session: EarningsTiming | null; label: string }> = [
  { session: "bmo", label: "Before open" },
  { session: "dmh", label: "During market" },
  { session: "amc", label: "After close" },
  { session: null, label: "Time not set" },
];

export interface CalendarGroup {
  session: EarningsTiming | null;
  label: string;
  /** The ones drawn, largest first (held, then watched names lead when the board puts mine first). */
  reports: BoardReport[];
  /** Reports of this group past its limit, left to the table. */
  more: number;
}

export interface CalendarDay {
  date: string;
  /** "Mon" */
  weekday: string;
  /** "Oct 20" */
  label: string;
  today: boolean;
  /** No NYSE session that day. */
  closed: boolean;
  /** Every report that day, drawn or not. */
  total: number;
  /** Only the sessions with a report. */
  groups: CalendarGroup[];
}

/**
 * Monday to Friday of the week `offset` weeks from the one `today` falls in;
 * on a Saturday or Sunday "this week" is the one about to start.
 */
export function calendarWeekDates(today: string, offset: number): string[] {
  const day = new Date(`${today}T00:00:00Z`).getUTCDay();
  const monday = addDays(today, day === 0 ? 1 : day === 6 ? 2 : 1 - day);
  const start = addDays(monday, offset * 7);
  return [0, 1, 2, 3, 4].map((index) => addDays(start, index));
}

/** "Last week", "This week", "Next week", then "Week of Nov 3". */
export function calendarWeekLabel(today: string, offset: number): string {
  if (offset === -1) return "Last week";
  if (offset === 0) return "This week";
  if (offset === 1) return "Next week";
  return `Week of ${shortDate(calendarWeekDates(today, offset)[0]!)}`;
}

function bySize(left: BoardReport, right: BoardReport, mineFirst: boolean): number {
  const rank = ownershipRank(left, mineFirst) - ownershipRank(right, mineFirst);
  if (rank !== 0) return rank;
  // Missing caps sink, as they do in the table.
  if (left.marketCap !== right.marketCap) {
    if (left.marketCap == null) return 1;
    if (right.marketCap == null) return -1;
    return right.marketCap - left.marketCap;
  }
  return left.symbol.localeCompare(right.symbol);
}

/**
 * The week as the calendar draws it: a column per day, and in each the
 * reports grouped by when they come out, before the open, during the
 * session, after the close, and with no time yet. A group takes at most
 * `limit` slots: past it, its largest companies and a last slot that counts
 * the rest.
 */
export function calendarDays(
  reports: readonly BoardReport[],
  dates: readonly string[],
  { today, mineFirst = false, limit = Number.POSITIVE_INFINITY }: { today: string; mineFirst?: boolean; limit?: number },
): CalendarDay[] {
  return dates.map((date) => {
    const inDay = reports.filter((report) => report.date === date);
    const groups = SESSIONS.flatMap(({ session, label }): CalendarGroup[] => {
      const inGroup = inDay.filter((report) => report.timing === session).sort((left, right) => bySize(left, right, mineFirst));
      if (inGroup.length === 0) return [];
      // Past the limit, the last slot counts the rest.
      const shown = inGroup.length > limit ? inGroup.slice(0, Math.max(0, limit - 1)) : inGroup;
      return [{ session, label, reports: shown, more: inGroup.length - shown.length }];
    });
    return {
      date,
      weekday: weekday(date),
      label: shortDate(date),
      today: date === today,
      closed: !isSession(date),
      total: inDay.length,
      groups,
    };
  });
}
