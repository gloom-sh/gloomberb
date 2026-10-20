import { barLastSession } from "./bar-period";

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
export function yearToDateStartIndex(dates: readonly string[], interval?: string | null): number {
  const last = dates.at(-1);
  if (!last) return -1;
  const yearEnd = `${Number(last.slice(0, 4)) - 1}-12-31`;
  const closes = (date: string) => {
    const day = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
    if (interval === "1wk") return new Date(day + 6 * 86_400_000).toISOString().slice(0, 10);
    if (interval === "1mo") return new Date(Date.UTC(new Date(day).getUTCFullYear(), new Date(day).getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    return date.slice(0, 10);
  };
  for (let index = dates.length - 1; index >= 0; index -= 1) {
    if (closes(dates[index]!) <= yearEnd) return index;
  }
  return 0;
}
