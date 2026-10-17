/**
 * Daily sessions a source left out of a price history because its close was
 * at or below zero (CL=F settled at -37.63 on 2020-04-20): no price can stand
 * for them, so they are not bars, but a reader of the series is told they
 * were sessions.
 */

const SESSION_DATE = /^\d{4}-\d{2}-\d{2}$/;
// More than any daily history holds; a longer list is not one a source wrote.
const MAX_DATES = 10_000;

function isSessionDate(value: unknown): value is string {
  return typeof value === "string" && SESSION_DATE.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

/** A stored or passed-on list: unique session dates, ascending; undefined for anything else or nothing. */
export function readNonPositiveCloseDates(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_DATES || !value.every(isSessionDate)) return undefined;
  return [...new Set(value)].sort();
}

/**
 * The sessions a Gloom Cloud answer lists as left out for a close at or below
 * zero (`omittedSessions: [{ date, reason: "non-positive-close" }]`). Entries
 * for a reason this client does not know, or that do not read, are ignored.
 */
export function cloudNonPositiveCloseDates(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_DATES) return undefined;
  return readNonPositiveCloseDates(value.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object") return [];
    const { date, reason } = entry as { date?: unknown; reason?: unknown };
    return reason === "non-positive-close" && isSessionDate(date) ? [date] : [];
  }));
}
