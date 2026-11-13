import { MISSING_VALUE } from "./format";
import { toTimestampMillis } from "./timestamp";
import { timeZoneLabel } from "./zoned-date-time";

export type DisplayDateValue = Date | string | number | null | undefined;

export function parseDisplayDate(value: DisplayDateValue): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Whole minutes, hours or days in an age, the one ladder every relative-time
 * label reads from. Null under a minute, which includes a time in the future.
 */
function elapsedUnits(ageMs: number): { count: number; unit: "m" | "h" | "d" } | null {
  if (!(ageMs >= 60_000)) return null;
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return { count: minutes, unit: "m" };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { count: hours, unit: "h" };
  return { count: Math.floor(hours / 24), unit: "d" };
}

/** Age for a narrow column: "<1m", "5m", "3h", "2d". */
export function formatRelativeTime(value: DisplayDateValue, now = Date.now(), fallback = MISSING_VALUE): string {
  const date = parseDisplayDate(value);
  if (!date) return fallback;

  const ms = now - date.getTime();
  if (!Number.isFinite(ms)) return fallback;
  const elapsed = elapsedUnits(ms);
  return elapsed ? `${elapsed.count}${elapsed.unit}` : "<1m";
}

/** Age of an epoch-ms timestamp: "just now", "5m ago", "3h ago", "2d ago"; `empty` when unset. */
export function formatRelativeAge(timestamp: number | undefined, now = Date.now(), empty = "never"): string {
  if (!timestamp) return empty;
  const elapsed = elapsedUnits(now - timestamp);
  return elapsed ? `${elapsed.count}${elapsed.unit} ago` : "just now";
}

/** Time until something scheduled, on the same ladder: "in <1m", "in 25m", "in 3h", "in 3h 20m". */
export function formatCountdown(ms: number): string {
  if (ms <= 60_000) return "in <1m";
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 60) return `in ${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `in ${h}h ${m}m` : `in ${h}h`;
}

// Reuse the locale formatter when a feed contains older items. Constructing
// one for every row dominates opening a long transcript, even without edits.

/**
 * Relative time that turns into a date ("1/5/26") after a week, for feeds read
 * by recency: "just now", "5m ago", "3h ago", "2d ago". `short` drops the
 * "ago" for a narrow column ("<1m", "5m").
 */
export function formatTimeAgo(date: Date | string, { short = false }: { short?: boolean } = {}): string {
  const ts = toTimestampMillis(date);
  if (Number.isNaN(ts)) return "unknown";
  const elapsed = elapsedUnits(Date.now() - ts);
  if (!elapsed) return short ? "<1m" : "just now";
  if (elapsed.unit === "d" && elapsed.count >= 7) {
    // As a feed writes a day past the week: "5 Nov", "5 Nov '25" in another year, never "11/5/26".
    const date = new Date(ts);
    return formatShortDate(date, { year: date.getFullYear() === new Date().getFullYear() ? false : "2-digit" });
  }
  return `${elapsed.count}${elapsed.unit}${short ? "" : " ago"}`;
}

export interface ShortDateOptions {
  /** "5 Jan 2026" (the default), "5 Jan '26" as option expiries write it, or no year at all ("5 Jan"). */
  year?: "numeric" | "2-digit" | false;
  /** "2-digit" pads the day so dates line up in a column ("05 Jan"). */
  day?: "numeric" | "2-digit";
  /** Read the day in UTC, for date-only values that name a calendar day rather than an instant. */
  utc?: boolean;
  /** Shown when the value is missing or does not parse. */
  fallback?: string;
}

const shortDateFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * A formatter's date written day first ("Fri 5 Jan 2026"). A two-digit year
 * takes an apostrophe ("5 Jan '26"), so it never reads as another day.
 */
export function dayFirstParts(formatter: Intl.DateTimeFormat, date: Date): string {
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const year = parts.year ? ` ${parts.year.length === 2 ? `'${parts.year}` : parts.year}` : "";
  return `${parts.weekday ? `${parts.weekday} ` : ""}${parts.day} ${parts.month}${year}`;
}

/** A day-first month-name date such as "5 Jan 2026", in local time unless `utc` is set. */
export function formatShortDate(value: DisplayDateValue, options: ShortDateOptions = {}): string {
  const date = parseDisplayDate(value);
  if (!date) return options.fallback ?? MISSING_VALUE;
  const { year = "numeric", day = "numeric", utc = false } = options;
  const key = `${year}:${day}:${utc}`;
  let formatter = shortDateFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      month: "short",
      day,
      year: year || undefined,
      timeZone: utc ? "UTC" : undefined,
    });
    shortDateFormatters.set(key, formatter);
  }
  return dayFirstParts(formatter, date);
}

const weekdayDayFormatters = new Map<string, Intl.DateTimeFormat>();

/** A weekday and day-first date ("Fri 16 Oct"), with a year only when asked for. */
export function formatWeekdayDay(value: DisplayDateValue, { timeZone, year = false }: { timeZone?: string; year?: boolean } = {}): string {
  const date = parseDisplayDate(value);
  if (!date) return MISSING_VALUE;
  const key = `${timeZone ?? ""}:${year}`;
  let formatter = weekdayDayFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { weekday: "short", day: "numeric", month: "short", year: year ? "numeric" : undefined, timeZone });
    weekdayDayFormatters.set(key, formatter);
  }
  return dayFirstParts(formatter, date);
}

/**
 * The day a filing is dated, as the agency and the filer write it: "04 Nov
 * 2026", the day padded so a column of them lines up. A calendar day, read in
 * UTC, so it never moves with the viewer's zone: give it the filing date
 * (`2026-11-04`, or that day at midnight UTC), not an acceptance instant,
 * which can fall on the evening before or on a weekend.
 */
export function formatFilingDate(value: DisplayDateValue, fallback = "\u2014"): string {
  return formatShortDate(value, { day: "2-digit", utc: true, fallback });
}

const clockFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const weekdayClockFormatter = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const utcClockFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});
const utcWeekdayClockFormatter = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

function localMidnight(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function utcMidnight(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * When a feed item was published, in local time, as a newswire prints it:
 * the time today ("14:32"), the weekday and time over the six days before
 * ("Mon 09:10"), and the date for anything older ("18 Sep", or "18 Sep '25"
 * in another year). A weekday never names a day a week or more back. With
 * `utc`, the same in UTC, for a column whose header names the zone.
 */
export function formatFeedTime(
  value: DisplayDateValue,
  now = Date.now(),
  fallback = MISSING_VALUE,
  { utc = false, dayToday = false }: {
    utc?: boolean;
    /** Today's time carries its weekday too ("Sat 00:47"), for a column whose other rows name theirs ("Fri 21:00"). */
    dayToday?: boolean;
  } = {},
): string {
  const date = parseDisplayDate(value);
  if (!date) return fallback;
  const today = new Date(now);
  const midnight = utc ? utcMidnight : localMidnight;
  // Rounded, since a day with a DST change is 23 or 25 hours long.
  const daysAgo = Math.round((midnight(today) - midnight(date)) / 86_400_000);
  if (daysAgo === 0 && !dayToday) return (utc ? utcClockFormatter : clockFormatter).format(date);
  if (daysAgo >= 0 && daysAgo < 7) return (utc ? utcWeekdayClockFormatter : weekdayClockFormatter).format(date).replace(",", "");
  const sameYear = utc ? date.getUTCFullYear() === today.getUTCFullYear() : date.getFullYear() === today.getFullYear();
  return formatShortDate(date, { year: sameYear ? false : "2-digit", utc });
}

/**
 * A date and time in the host's zone, with the zone named: "7 Oct 2026,
 * 23:38 CET", "... 17:38 ET", "... 21:38 UTC". Without the zone a
 * time read beside a list in UTC looks two hours off.
 */
export function formatDetailDate(value: DisplayDateValue, fallback = MISSING_VALUE, timeZone?: string): string {
  const date = parseDisplayDate(value);
  if (!date) return fallback;

  const datePart = dayFirstParts(new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone,
  }), date);
  return `${datePart}, ${formatDetailTime(date, fallback, timeZone)}`;
}

/**
 * The host's zone as a time beside it names it, for a column header over times
 * in that zone ("TIME CET"), as `formatDetailTime` names it after one time:
 * the name the charts and session lines give it at that time ("UTC", "ET",
 * "CET" or "CEST", "JST", else the city). News read "TIME GMT+1" over a
 * chart's "CET" (review, 12 Nov 2026).
 */
export function localTimeZoneShortName(now: DisplayDateValue = Date.now(), timeZone?: string): string {
  const zone = timeZone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  return timeZoneLabel(zone, (parseDisplayDate(now) ?? new Date()).getTime());
}

const zonedClockFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * A time of day on the 24-hour clock every pane reads ("09:05", "23:38"), in
 * the host's zone unless `timeZone` is given. Never AM/PM: one footer read
 * "8:30 AM" beside another's "14:32" (review, 12 Nov 2026).
 */
export function formatClockTime(value: DisplayDateValue, fallback = MISSING_VALUE, timeZone?: string): string {
  const date = parseDisplayDate(value);
  if (!date) return fallback;
  if (!timeZone) return clockFormatter.format(date);
  let formatter = zonedClockFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone });
    zonedClockFormatters.set(timeZone, formatter);
  }
  return formatter.format(date);
}

/** The time of `formatDetailDate` alone, its zone named: "23:38 CET", for a day stated beside it. */
export function formatDetailTime(value: DisplayDateValue, fallback = MISSING_VALUE, timeZone?: string): string {
  const date = parseDisplayDate(value);
  if (!date) return fallback;
  return `${formatClockTime(date, fallback, timeZone)} ${localTimeZoneShortName(date, timeZone)}`;
}
