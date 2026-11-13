export interface ZonedDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, value);
  }
  return value;
}

export function zonedDateTimeParts(utcMs: number, timeZone: string): ZonedDateTimeParts {
  const parts = new Map<string, string>();
  for (const part of formatter(timeZone).formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") parts.set(part.type, part.value);
  }
  return {
    year: Number(parts.get("year")),
    month: Number(parts.get("month")),
    day: Number(parts.get("day")),
    hour: Number(parts.get("hour")),
    minute: Number(parts.get("minute")),
    second: Number(parts.get("second")),
  };
}

const dateKeyFormatters = new Map<string, Intl.DateTimeFormat>();

/** The calendar day an instant falls on in an IANA timezone, as "YYYY-MM-DD". */
export function zonedDateKey(utcMs: number, timeZone: string): string {
  let value = dateKeyFormatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    dateKeyFormatters.set(timeZone, value);
  }
  return value.format(utcMs);
}

function zonedOffsetMs(utcMs: number, timeZone: string): number {
  const parts = zonedDateTimeParts(utcMs, timeZone);
  const wallMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wallMs - Math.floor(utcMs / 1000) * 1000;
}

/** Convert a wall-clock reading in an IANA timezone to a real UTC instant. */
export function zonedWallClockToUtcMs(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond = 0,
): number {
  const wallMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const firstOffset = zonedOffsetMs(wallMs, timeZone);
  const candidate = wallMs - firstOffset;
  const verifiedOffset = zonedOffsetMs(candidate, timeZone);
  return wallMs - verifiedOffset;
}

const QUARTER_HOUR_MS = 15 * 60_000;
const offsetBuckets = new Map<string, Map<number, number>>();

/**
 * An instant's wall-clock reading in a zone, as a timestamp whose UTC fields
 * read the local date and time. Offsets only change on quarter-hour edges, so
 * each quarter hour is measured once.
 */
export function zonedWallClockMs(utcMs: number, timeZone: string): number {
  if (!Number.isFinite(utcMs)) return utcMs;
  let buckets = offsetBuckets.get(timeZone);
  if (!buckets) {
    buckets = new Map();
    offsetBuckets.set(timeZone, buckets);
  }
  const bucket = Math.floor(utcMs / QUARTER_HOUR_MS);
  let offset = buckets.get(bucket);
  if (offset === undefined) {
    offset = zonedOffsetMs(bucket * QUARTER_HOUR_MS, timeZone);
    if (buckets.size >= 100_000) buckets.clear();
    buckets.set(bucket, offset);
  }
  return utcMs + offset;
}

/** A zone's winter and summer names, for a zone that names the two apart. */
type SeasonNames = readonly [winter: string, summer: string];
const CENTRAL_EUROPE: SeasonNames = ["CET", "CEST"];

// The short names zones go by. The Americas and Australasia have one for the
// whole year, the way the tape writes "ET"; Europe names its summer time apart
// ("CET", "CEST"). Any other zone is named by its city.
const TIME_ZONE_LABELS: Readonly<Record<string, string | SeasonNames>> = {
  UTC: "UTC",
  "Etc/UTC": "UTC",
  "America/New_York": "ET",
  "America/Toronto": "ET",
  "America/Chicago": "CT",
  "America/Denver": "MT",
  "America/Los_Angeles": "PT",
  "America/Vancouver": "PT",
  "America/Sao_Paulo": "BRT",
  "America/Argentina/Buenos_Aires": "ART",
  "Europe/London": ["GMT", "BST"],
  "Europe/Lisbon": ["WET", "WEST"],
  "Europe/Berlin": CENTRAL_EUROPE,
  "Europe/Paris": CENTRAL_EUROPE,
  "Europe/Amsterdam": CENTRAL_EUROPE,
  "Europe/Brussels": CENTRAL_EUROPE,
  "Europe/Madrid": CENTRAL_EUROPE,
  "Europe/Rome": CENTRAL_EUROPE,
  "Europe/Zurich": CENTRAL_EUROPE,
  "Europe/Vienna": CENTRAL_EUROPE,
  "Europe/Stockholm": CENTRAL_EUROPE,
  "Europe/Copenhagen": CENTRAL_EUROPE,
  "Europe/Oslo": CENTRAL_EUROPE,
  "Europe/Warsaw": CENTRAL_EUROPE,
  "Europe/Prague": CENTRAL_EUROPE,
  "Europe/Helsinki": ["EET", "EEST"],
  "Atlantic/Reykjavik": "GMT",
  "Africa/Johannesburg": "SAST",
  "Asia/Kolkata": "IST",
  "Asia/Hong_Kong": "HKT",
  "Asia/Singapore": "SGT",
  "Asia/Tokyo": "JST",
  "Asia/Seoul": "KST",
  "Australia/Sydney": "AET",
  "Pacific/Auckland": "NZT",
};

/** Whether `at` falls in the zone's summer time: its offset then is past its winter one. */
function onSummerTime(timeZone: string, at: number): boolean {
  const year = new Date(at).getUTCFullYear();
  const offsetAt = (utcMs: number) => zonedWallClockMs(utcMs, timeZone) - utcMs;
  return offsetAt(at) > Math.min(offsetAt(Date.UTC(year, 0, 1)), offsetAt(Date.UTC(year, 6, 1)));
}

/**
 * The short name a zone goes by at `at` ("ET" for New York, "JST" for Tokyo,
 * "CET" or "CEST" for Paris, "GMT" or "BST" for London), when it has one.
 */
function knownTimeZoneLabel(timeZone: string, at: number = Date.now()): string | undefined {
  const names = TIME_ZONE_LABELS[timeZone];
  if (names === undefined || typeof names === "string") return names;
  return names[Number.isFinite(at) && onSummerTime(timeZone, at) ? 1 : 0];
}

/** A zone's short name at `at` (`knownTimeZoneLabel`), else its city: every chart, session line and time column names a zone so. */
export function timeZoneLabel(timeZone: string, at: number = Date.now()): string {
  return knownTimeZoneLabel(timeZone, at) ?? timeZone.split("/").at(-1)!.replaceAll("_", " ");
}
