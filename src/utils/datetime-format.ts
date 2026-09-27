import { toTimestampMillis } from "./timestamp";

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
export function formatRelativeTime(value: DisplayDateValue, now = Date.now(), fallback = "-"): string {
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
    return new Date(ts).toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "2-digit" });
  }
  return `${elapsed.count}${elapsed.unit}${short ? "" : " ago"}`;
}

export interface ShortDateOptions {
  /** "Jan 5, 2026" (the default), "Jan 5, 26", or no year at all ("Jan 5"). */
  year?: "numeric" | "2-digit" | false;
  /** "2-digit" pads the day so dates line up in a column ("Jan 05"). */
  day?: "numeric" | "2-digit";
  /** Read the day in UTC, for date-only values that name a calendar day rather than an instant. */
  utc?: boolean;
  /** Shown when the value is missing or does not parse. */
  fallback?: string;
}

const shortDateFormatters = new Map<string, Intl.DateTimeFormat>();

/** A month-name date such as "Jan 5, 2026", in local time unless `utc` is set. */
export function formatShortDate(value: DisplayDateValue, options: ShortDateOptions = {}): string {
  const date = parseDisplayDate(value);
  if (!date) return options.fallback ?? "-";
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
  return formatter.format(date);
}

export function formatDetailDate(value: DisplayDateValue, fallback = "-"): string {
  const date = parseDisplayDate(value);
  if (!date) return fallback;

  const datePart = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const timePart = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${datePart} at ${timePart}`;
}
