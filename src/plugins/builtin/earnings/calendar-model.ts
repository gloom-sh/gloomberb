import type { EarningsTiming } from "../../../api-client/earnings";
import { addDays, isSession, marketDays, ownershipRank, type BoardReport, type MarketDay } from "./board-model";
import { shortDate, weekday } from "./format";

/** The weeks the calendar view offers, from the one before this week to three ahead. */
export const CALENDAR_WEEK_OFFSETS = [-1, 0, 1, 2, 3] as const;
type CalendarWeekOffset = (typeof CALENDAR_WEEK_OFFSETS)[number];

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
  /** Reports of this group past its limit, counted in its last slot until the group is expanded. */
  more: number;
}

/** Names a day's group, so a "+N more" slot can expand that group alone. */
export function calendarGroupKey(date: string, session: EarningsTiming | null): string {
  return `${date}:${session ?? "unset"}`;
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

/** The weeks `--week` names, as offsets from this week. */
export const BOARD_WEEKS = ["last", "this", "next"] as const;
export type BoardWeek = typeof BOARD_WEEKS[number];
const BOARD_WEEK_OFFSET: Record<BoardWeek, CalendarWeekOffset> = { last: -1, this: 0, next: 1 };

export function isBoardWeek(value: unknown): value is BoardWeek {
  return typeof value === "string" && (BOARD_WEEKS as readonly string[]).includes(value);
}

/**
 * The days a board shows, as the pane's Range saves them: "" for the days
 * ahead (the default), a week as its offset from this one ("-1" last week,
 * "2" the week after next), or one day as YYYY-MM-DD. The table draws a
 * section per day of it; the calendar draws its week.
 */
export type BoardRange = string;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_OFFSET = /^-?\d+$/;

/** The range `--date` or `--week` asks for; the days ahead without either. */
export function requestedBoardRange(date: unknown, week: unknown): BoardRange {
  if (typeof date === "string" && ISO_DAY.test(date)) return date;
  return isBoardWeek(week) ? String(BOARD_WEEK_OFFSET[week]) : "";
}

/** A range that is one day (`--date`), not a week or the days ahead. */
export function isBoardRangeDay(range: BoardRange): boolean {
  return ISO_DAY.test(range);
}

function mondayOf(date: string): string {
  return calendarWeekDates(date, 0)[0]!;
}

/** The week a range falls in, from this week: a day's own week, and this week for the days ahead. */
export function boardRangeWeek(range: BoardRange, today: string): number {
  if (WEEK_OFFSET.test(range)) return Number(range);
  if (!ISO_DAY.test(range)) return 0;
  return Math.round((Date.parse(mondayOf(range)) - Date.parse(mondayOf(today))) / (7 * 86_400_000));
}

/** A day of a week or the day asked for: "Today" for today, otherwise "Thu Oct 15". */
function dayLabel(date: string, today: string): string {
  return date === today ? "Today" : `${weekday(date)} ${shortDate(date)}`;
}

/**
 * The table's sections for `range`: the market's days ahead by default, one
 * section per weekday of a week, or the one day asked for. Days without
 * reports (a holiday) leave no section.
 */
export function boardRangeDays(range: BoardRange, today: string): MarketDay[] {
  if (ISO_DAY.test(range)) return [{ label: dayLabel(range, today), from: range, to: range }];
  if (!WEEK_OFFSET.test(range)) return marketDays(today);
  return calendarWeekDates(today, Number(range)).map((date) => ({ label: dayLabel(date, today), from: date, to: date }));
}

/** What the range reads as: "Last week", "Week of Nov 2", "Thu Oct 15", or null for the days ahead. */
export function boardRangeLabel(range: BoardRange, today: string): string | null {
  if (ISO_DAY.test(range)) return dayLabel(range, today);
  return WEEK_OFFSET.test(range) ? calendarWeekLabel(today, Number(range)) : null;
}

/** The range in a sentence ("No reports … last week"): "today", "on Thu Oct 15", "in the week of Nov 2"; null for the days ahead. */
export function boardRangeWords(range: BoardRange, today: string): string | null {
  if (ISO_DAY.test(range)) return range === today ? "today" : `on ${dayLabel(range, today)}`;
  if (!WEEK_OFFSET.test(range)) return null;
  const offset = Number(range);
  return offset >= -1 && offset <= 1 ? calendarWeekLabel(today, offset).toLowerCase() : `in the week of ${shortDate(calendarWeekDates(today, offset)[0]!)}`;
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
 * the rest. A group named in `expanded` (see `calendarGroupKey`) draws all
 * of its reports.
 */
export function calendarDays(
  reports: readonly BoardReport[],
  dates: readonly string[],
  { today, mineFirst = false, limit = Number.POSITIVE_INFINITY, expanded }: {
    today: string;
    mineFirst?: boolean;
    limit?: number;
    expanded?: ReadonlySet<string>;
  },
): CalendarDay[] {
  return dates.map((date) => {
    const inDay = reports.filter((report) => report.date === date);
    const groups = SESSIONS.flatMap(({ session, label }): CalendarGroup[] => {
      const inGroup = inDay.filter((report) => report.timing === session).sort((left, right) => bySize(left, right, mineFirst));
      if (inGroup.length === 0) return [];
      // Past the limit, the last slot counts the rest.
      const shown = inGroup.length > limit && !expanded?.has(calendarGroupKey(date, session))
        ? inGroup.slice(0, Math.max(0, limit - 1))
        : inGroup;
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
