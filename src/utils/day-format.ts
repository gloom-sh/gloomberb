import { formatFilingDate, formatShortDate, parseDisplayDate, type DisplayDateValue } from "./datetime-format";
import { MISSING_VALUE } from "./format";

const ISO_DAY = /^(\d{4}-\d{2}-\d{2})(?:$|[T ])/;

/**
 * The calendar day a value names, as an ISO day (`2026-08-21`): the day an
 * ISO date or timestamp string starts with, as written, or a Date or epoch
 * read in UTC. Null for anything else, a month (`2026-10`) or a word included.
 */
export function isoDay(value: unknown): string | null {
  if (typeof value === "string") return ISO_DAY.exec(value.trim())?.[1] ?? null;
  const date = value instanceof Date || typeof value === "number" ? parseDisplayDate(value) : null;
  return date ? date.toISOString().slice(0, 10) : null;
}

/** `21 Aug 2026`, or `21 Aug` where a column has no room for the year. */
export type DayCellForm = "full" | "no-year";

/**
 * A calendar day as every table, and the text report beside it, writes one
 * (docs/pane-conventions.md, "One date format"): `21 Aug 2026`, `21 Aug`.
 * Text that names no day (`TBD`) is kept; nothing is the dash.
 */
export function formatDay(value: unknown, form: DayCellForm = "full"): string {
  const day = isoDay(value);
  if (!day) return typeof value === "string" && value.trim() ? value : MISSING_VALUE;
  return form === "no-year" ? formatShortDate(day, { year: false, day: "2-digit", utc: true }) : formatFilingDate(day);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_TEXT = /^(\d{2}) ([A-Z][a-z]{2}) (\d{4})$/;

/** The ISO day `formatDay` wrote (`21 Aug 2026` is `2026-08-21`), so an export of a drawn day keeps the day; null for other text. */
export function dayFromText(text: string): string | null {
  const match = DAY_TEXT.exec(text.trim());
  const month = match ? MONTHS.indexOf(match[2]!) : -1;
  return match && month >= 0 ? `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[1]}` : null;
}

const dayTimeFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * An instant as a table writes it beside its day: `09 Oct 2026 13:21`, the day
 * first as every table's dates, in UTC unless a zone is given; the column's
 * header names the zone (`LAST UTC`). The dash when there is none.
 */
export function formatDayTime(value: DisplayDateValue, timeZone = "UTC"): string {
  const date = parseDisplayDate(value);
  if (!date) return MISSING_VALUE;
  let formatter = dayTimeFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone });
    dayTimeFormatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.day} ${parts.month} ${parts.year} ${parts.hour}:${parts.minute}`;
}
