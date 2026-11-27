// Narrowing helpers for unknown payloads: decoded JSON, persisted state, RPC
// messages and anything else that crosses a trust boundary.

/** A plain object: not null and not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The value as a plain object, or null when it is not one. */
export function recordOrNull(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/** The value as a plain object, or an empty one, so nested reads can chain. */
export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** A number that is not NaN or infinite. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** The value when it is a finite number, otherwise null. */
export function finiteOrNull(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

/** An array holding only strings. */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** A string that parses as a date. */
export function isDateString(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** The value as a trimmed string, or null when it is not a string or is blank. */
export function textOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** A field that may hold text or a number, as text: a finite number is written out. */
export function scalarTextOrNull(value: unknown): string | null {
  return isFiniteNumber(value) ? String(value) : textOrNull(value);
}

/** A finite number, or a string that reads as one ("12.5"). A blank string is null, not 0. */
export function numericOrNull(value: unknown): number | null {
  if (typeof value === "number") return finiteOrNull(value);
  if (typeof value !== "string" || !value.trim()) return null;
  return finiteOrNull(Number(value));
}

/** The YYYY-MM-DD day an ISO date or timestamp string starts with, or null. */
export function isoDateOrNull(value: unknown): string | null {
  const text = textOrNull(value);
  return text && /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

/** A finite number strictly greater than zero. */
export function isPositiveNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

/** A finite number greater than or equal to zero. */
export function isNonNegative(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

/** A non-negative integer. */
export function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** A finite number in [0, 1]. */
export function isFraction(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

/** A string containing at least one non-whitespace character. */
export function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Either null or a string (including empty string). */
export function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** Either null or a non-empty string. */
export function isNullableText(value: unknown): value is string | null {
  return value === null || isNonEmptyText(value);
}

/** Either null or a finite number. */
export function isNullableFinite(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

const CALENDAR_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CALENDAR_MONTH_RE = /^(\d{4})-(\d{2})$/;

/** A strict YYYY-MM-DD calendar date (rejects rolled-over dates like 2026-02-30). */
export function isCalendarDay(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = CALENDAR_DAY_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

export function isNullableCalendarDay(value: unknown): value is string | null {
  return value === null || isCalendarDay(value);
}

/** A YYYY-MM calendar month (01–12). */
export function isCalendarMonth(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = CALENDAR_MONTH_RE.exec(value);
  if (!match) return false;
  const month = Number(match[2]);
  return month >= 1 && month <= 12;
}

/** A non-empty string that parses as a timestamp. */
export function isIsoInstant(value: unknown): value is string {
  return isNonEmptyText(value) && Number.isFinite(Date.parse(value));
}

export function isNullableIsoInstant(value: unknown): value is string | null {
  return value === null || isIsoInstant(value);
}

function isUrlWithProtocols(value: unknown, protocols: readonly string[]): value is string {
  if (!isNonEmptyText(value)) return false;
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    // Intentional ignore: malformed URLs fail the URL guard.
    return false;
  }
}

/** An `http:` or `https:` URL string. */
export function isHttpUrl(value: unknown): value is string {
  return isUrlWithProtocols(value, ["http:", "https:"]);
}

/** An `https:` URL string. */
export function isHttpsUrl(value: unknown): value is string {
  return isUrlWithProtocols(value, ["https:"]);
}

/** A 3-letter uppercase ISO currency code. */
export function isCurrencyCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value);
}

/** True when every row has a distinct `id` value. */
export function hasUniqueIds(rows: ReadonlyArray<{ id: string }>): boolean {
  return new Set(rows.map((row) => row.id)).size === rows.length;
}
