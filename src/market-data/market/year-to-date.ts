import { barLastSession } from "./bar-period";
import { barCloseDay, barSessionDay, periodBaseDay, periodBaseIndex } from "./period-return";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * The session a year-to-date figure dated `day` is measured from at `venue`:
 * the venue's last close of the year before, `YYYY-MM-DD`. 2026 runs from
 * Wed 31 Dec 2025, 2023 from Fri 30 Dec 2022 (31 Dec was a Saturday). A venue
 * whose sessions are unknown reads December's last weekday.
 */
export function yearToDateBaseDay(day: string, venue: string | undefined, now = Date.now()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}/.test(day)) return null;
  return barLastSession(`${Number(day.slice(0, 4)) - 1}-12-01`, "month", venue, now);
}

/** That close as a column header names it, `31 Dec`. */
export function yearToDateBaseLabel(day: string, venue: string | undefined, now = Date.now()): string {
  const base = yearToDateBaseDay(day, venue, now) ?? `${Number(day.slice(0, 4)) - 1}-12-31`;
  const date = new Date(`${base}T00:00:00Z`);
  return Number.isFinite(date.getTime()) ? `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}` : "31 Dec";
}

/**
 * Where a year-to-date run of bars starts: the last bar whose close is from on
 * or before 31 Dec of the year before the newest bar, the close the year is
 * measured from, never the year's first session. A weekly bar (dated by its
 * week's start) closes as its week ends and a monthly one as its month does,
 * so the week of Mon 29 Dec 2025, which closes on 2 Jan, is after it. 0 when
 * every bar is from the year itself (a listing that started trading in it);
 * -1 without bars.
 */
export function yearToDateStartIndex(dates: readonly string[], interval?: string | null, venue?: string): number {
  // A timestamped bar is read on the venue's clock (barSessionDay), a crypto week as running through Sunday.
  const days = dates.map((date) => date.length > 10 && Number.isFinite(Date.parse(date)) ? barSessionDay(Date.parse(date), venue) : date.slice(0, 10));
  const last = days.at(-1);
  if (!last) return -1;
  // The listing's whole history counts here, however far before 31 Dec its last close of the year was.
  const index = periodBaseIndex(days.map((day) => barCloseDay(day, interval, venue)), periodBaseDay(last, "YTD"), Number.POSITIVE_INFINITY);
  return Math.max(0, index);
}
