import { parseReportTime } from "./utc-time";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * When a statistic was released, said after the period it covers:
 * `released Tue 20 Oct`, with the year when it is not the year of the period
 * (`released Fri 15 Jan 2027` for December 2026's figure), and the time in
 * UTC for a release known to the minute (`released Wed 14 Oct 12:30 UTC`).
 * `periodStart` is the date the figure is dated by (`2026-09-01`). Null when
 * `released` is not a date.
 */
export function releasedText(released: unknown, periodStart?: string | null): string | null {
  const time = parseReportTime(released);
  if (!time) return null;
  const day = new Date(time.time);
  const periodYear = periodStart ? Number(periodStart.slice(0, 4)) : Number.NaN;
  const year = day.getUTCFullYear() === periodYear ? "" : ` ${day.getUTCFullYear()}`;
  const date = `${WEEKDAYS[day.getUTCDay()]} ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]}${year}`;
  return `released ${date}${time.dateOnly ? "" : ` ${day.toISOString().slice(11, 16)} UTC`}`;
}

/**
 * The period a figure covers and when it was released, as every macro pane,
 * report and footer says it: `Sep 2026, released Tue 20 Oct`. The period
 * alone when the release is not known.
 */
export function periodReleasedText(period: string, released: unknown, periodStart?: string | null): string {
  const text = releasedText(released, periodStart);
  return text ? `${period}, ${text}` : period;
}

/**
 * How often a figure dated by the first day of its period publishes, from the
 * prints a year holds (12 for monthly): `monthly` for `2026-09-01`, `quarterly`
 * for `2026-07-01`. Null for a weekly or daily print, or a date that starts no
 * such period.
 */
export function periodStartPeriodicity(date: string, perYear: number): "monthly" | "quarterly" | "annual" | null {
  const match = /^\d{4}-(\d{2})-01/.exec(date);
  if (!match || perYear > 12) return null;
  const month = Number(match[1]) - 1;
  if (perYear <= 1) return month === 0 ? "annual" : null;
  if (perYear <= 4) return month % 3 === 0 ? "quarterly" : null;
  return "monthly";
}
