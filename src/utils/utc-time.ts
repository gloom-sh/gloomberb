import { zonedDateTimeParts } from "./zoned-date-time";

/**
 * Times in CLI and report text print in UTC with the zone named, so a value
 * copied out of a report means the same thing on every machine and in every
 * time zone. A reader who set a time zone (`config set timezone`) also gets
 * their own clock beside it. JSON keeps the raw ISO or epoch values.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** An ISO date and time with an explicit zone; one without a zone cannot be placed in UTC. */
const ZONED_ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
// Epoch milliseconds between 2001 and 2286, so counts and prices are never read as times.
const EPOCH_MS_MIN = 1e12;
const EPOCH_MS_MAX = 1e13;

export interface ReportTime {
  /** Epoch milliseconds; a date-only value sits at UTC midnight. */
  time: number;
  /** The value named a calendar date, not an instant. */
  dateOnly: boolean;
}

export function isEpochMilliseconds(value: number): boolean {
  return Number.isFinite(value) && value >= EPOCH_MS_MIN && value < EPOCH_MS_MAX;
}

export function isZonedIsoDateTime(value: string): boolean {
  return ZONED_ISO_DATE_TIME.test(value);
}

/**
 * Reads a Date, epoch milliseconds, an ISO date or a zoned ISO date and time.
 * A date and time without a zone, or anything else, is not a report time.
 */
export function parseReportTime(value: unknown): ReportTime | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? { time, dateOnly: false } : null;
  }
  if (typeof value === "number") return isEpochMilliseconds(value) ? { time: value, dateOnly: false } : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (DATE_ONLY.test(text)) {
    const time = Date.parse(`${text}T00:00:00Z`);
    return Number.isFinite(time) ? { time, dateOnly: true } : null;
  }
  if (!ZONED_ISO_DATE_TIME.test(text)) return null;
  const time = Date.parse(text);
  return Number.isFinite(time) ? { time, dateOnly: false } : null;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
/** Region/City names and UTC; offsets (`+09:00`) and abbreviations (`JST`) are not zones a clock is kept in. */
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;
/** Zones that read the same as UTC all year: a reader there needs no second time. */
const UTC_ZONES = new Set(["UTC", "ETC/UTC", "UCT", "ETC/UCT", "GMT", "ETC/GMT", "GMT0", "ETC/GMT0", "ETC/GMT+0", "ETC/GMT-0",
  "GREENWICH", "ETC/GREENWICH", "UNIVERSAL", "ETC/UNIVERSAL", "ZULU", "ETC/ZULU"]);

let displayZone: string | null = null;

/** The IANA name a time zone is known by (`asia/tokyo` is `Asia/Tokyo`), or null when the text names none. */
export function canonicalTimeZone(value: string): string | null {
  const name = value.trim();
  if (!ZONE_NAME.test(name)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * The zone CLI text shows a second, local time in, beside every UTC time. Unset,
 * an unknown name or a zone that is UTC all year prints UTC alone.
 */
export function setDisplayTimeZone(zone: string | null | undefined): void {
  const canonical = zone ? canonicalTimeZone(zone) : null;
  displayZone = canonical && !UTC_ZONES.has(canonical.toUpperCase()) ? canonical : null;
}

/**
 * ` (Sun 11 Oct 01:56 Asia/Tokyo)`: an instant on the reader's clock, to follow
 * its UTC time, with the weekday and date because the two can fall on
 * different days. Empty when no zone is set.
 */
export function localTimeSuffix(time: number): string {
  if (!displayZone || !Number.isFinite(time)) return "";
  const local = zonedDateTimeParts(time, displayZone);
  const weekday = WEEKDAYS[new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay()];
  const clock = `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`;
  return ` (${weekday} ${local.day} ${MONTHS[local.month - 1]} ${clock} ${displayZone})`;
}

/**
 * `2026-10-09 00:08 UTC`, with the reader's local time beside it when they set
 * a zone. Only an explicitly date-only value prints as `2026-10-09`; midnight
 * instants keep their time and zone.
 */
export function formatUtcTime(value: ReportTime | Date | number | string): string {
  const parsed = typeof value === "object" && !(value instanceof Date) ? value : parseReportTime(value);
  if (!parsed) return typeof value === "string" ? value : "";
  const iso = new Date(parsed.time).toISOString();
  if (parsed.dateOnly) return iso.slice(0, 10);
  return `${iso.slice(0, 16).replace("T", " ")} UTC${localTimeSuffix(parsed.time)}`;
}

/** The newest of some report times, as given, so a loader can declare its as-of from the rows it means. */
export function newestReportTime<T>(values: Iterable<T>): T | null {
  let best: { value: T; time: number } | null = null;
  for (const value of values) {
    const parsed = parseReportTime(value);
    if (parsed && (!best || parsed.time > best.time)) best = { value, time: parsed.time };
  }
  return best?.value ?? null;
}

export function oldestReportTime<T>(values: Iterable<T>): T | null {
  let best: { value: T; time: number } | null = null;
  for (const value of values) {
    const parsed = parseReportTime(value);
    if (parsed && (!best || parsed.time < best.time)) best = { value, time: parsed.time };
  }
  return best?.value ?? null;
}
