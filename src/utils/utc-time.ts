/**
 * Times in CLI and report text print in UTC with the zone named, so a value
 * copied out of a report means the same thing on every machine and in every
 * time zone. JSON keeps the raw ISO or epoch values.
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

/**
 * `2026-10-09 00:08 UTC`. A date-only value, or an instant at exactly UTC
 * midnight (how daily observations are stamped), prints as `2026-10-09`.
 */
export function formatUtcTime(value: ReportTime | Date | number | string): string {
  const parsed = typeof value === "object" && !(value instanceof Date) ? value : parseReportTime(value);
  if (!parsed) return typeof value === "string" ? value : "";
  const iso = new Date(parsed.time).toISOString();
  if (parsed.dateOnly || iso.endsWith("T00:00:00.000Z")) return iso.slice(0, 10);
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
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
