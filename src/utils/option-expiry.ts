/**
 * Option expiries as people type and read them. A chain stamps each expiry as
 * Unix seconds at that calendar date's UTC midnight, so a date and its stamp
 * convert both ways, and two stamps on the same UTC date are the same expiry.
 */

// 9999-12-31 in Unix seconds; a longer number is milliseconds or a typo.
const MAX_UNIX_SECONDS = 253_402_300_799;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const UNIX_SECONDS = /^\d{1,12}$/;
const DAY_MS = 86_400_000;

/** How `--expiration` is written, for usage lines and errors. */
export const OPTION_EXPIRATION_FORMAT = "YYYY-MM-DD (2028-01-21) or Unix seconds (1832025600)";
/** The value's name in a catalog flag, `--expiration <YYYY-MM-DD|unix>`. */
export const OPTION_EXPIRATION_PLACEHOLDER = "YYYY-MM-DD|unix";

/** The expiry's calendar date, `2028-01-21`; empty for a stamp that is not a time. */
export function expiryIsoDate(seconds: number): string {
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

/**
 * `--expiration` as the Unix seconds a chain request takes: `2028-01-21` is that
 * date at 00:00 UTC, a bare integer is already Unix seconds. Anything else,
 * including a date the calendar does not have, is null.
 */
export function parseOptionExpiration(raw: string): number | null {
  const text = raw.trim();
  const date = ISO_DATE.exec(text);
  if (date) {
    const [year, month, day] = [Number(date[1]), Number(date[2]), Number(date[3])];
    const at = new Date(Date.UTC(year, month - 1, day));
    const real = at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day;
    return real && at.getTime() > 0 ? at.getTime() / 1000 : null;
  }
  if (!UNIX_SECONDS.test(text)) return null;
  const seconds = Number(text);
  return seconds > 0 && seconds <= MAX_UNIX_SECONDS ? seconds : null;
}

/**
 * A pane function's typed expiry flag as the Unix seconds `parseOptionExpiration`
 * reads; throws an Error naming both accepted forms.
 */
export function expirationOptionSeconds(value: string, flag = "expiration"): number {
  const expiration = parseOptionExpiration(value);
  if (expiration == null) throw new Error(`Invalid --${flag} "${value}". Use ${OPTION_EXPIRATION_FORMAT}.`);
  return expiration;
}

/** A stored or typed expiry setting (seconds, or text `parseOptionExpiration` reads) as Unix seconds; null when it is neither. */
export function readOptionExpiration(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 && value <= MAX_UNIX_SECONDS ? value : null;
  return typeof value === "string" ? parseOptionExpiration(value) : null;
}

/** The listed stamp for the requested expiry's date, which may differ from the requested stamp in time of day. */
export function findListedExpiry(requested: number, expirations: readonly number[]): number | undefined {
  if (expirations.includes(requested)) return requested;
  const date = expiryIsoDate(requested);
  return date ? expirations.find((expiration) => expiryIsoDate(expiration) === date) : undefined;
}

/** Whole calendar days from the as-of date to the expiry, both read as UTC dates; negative once it has passed. */
export function daysToExpiry(expiration: number, asOfMs: number): number {
  const expiry = Date.parse(expiryIsoDate(expiration));
  const asOf = Date.parse(new Date(asOfMs).toISOString().slice(0, 10));
  return Math.round((expiry - asOf) / DAY_MS);
}

/** `469d` to expiry from the as-of date; `expired` once it has passed. */
export function formatDaysToExpiry(expiration: number, asOfMs: number): string {
  const days = daysToExpiry(expiration, asOfMs);
  return days < 0 ? "expired" : `${days}d`;
}

const NEAREST_EXPIRIES = 4;

/**
 * The listed expiries nearest a requested date, in date order, so a typo or an
 * unlisted LEAPS date points at the neighbours to pick. `listed` says the date
 * itself is listed (its chain came back empty); `more` counts the rest.
 */
function expiryChoices(requested: number, expirations: readonly number[]) {
  const { nearest, more, ...rest } = nearestListedExpiries(requested, expirations);
  return { ...rest, choices: `${nearest.join(", ")}${more > 0 ? ` (+${more} more)` : ""}` };
}

/**
 * Why a requested expiry is not in a catalogue, for a line that already names
 * the date: `not listed; nearest: 2027-12-17, 2028-01-21, … (+20 more)`.
 */
export function unlistedExpiryText(requested: number, expirations: readonly number[]): string {
  const { total, choices } = expiryChoices(requested, expirations);
  return total === 0 ? "not listed; the chain lists no expiries" : `not listed; nearest: ${choices}`;
}

function nearestListedExpiries(
  requested: number,
  expirations: readonly number[],
  count = NEAREST_EXPIRIES,
): { date: string; listed: boolean; nearest: string[]; more: number; total: number } {
  const date = expiryIsoDate(requested);
  const dates = [...new Set(expirations.map(expiryIsoDate).filter(Boolean))].sort();
  const others = dates.filter((listed) => listed !== date);
  const distance = (listed: string) => Math.abs(Date.parse(listed) - Date.parse(date));
  const nearest = [...others].sort((left, right) => distance(left) - distance(right) || left.localeCompare(right))
    .slice(0, count).sort();
  return { date, listed: dates.includes(date), nearest, more: others.length - nearest.length, total: dates.length };
}

/**
 * Why an expiry has no contracts, naming the nearest listed ones:
 * `no expiry 2028-01-22; available: 2027-12-17, 2028-01-21, … (+20 more)`.
 * `subject` names the underlying where nothing else on screen does.
 */
export function missingExpiryText(requested: number, expirations: readonly number[], subject?: string): string {
  const { date, listed, total, choices } = expiryChoices(requested, expirations);
  const of = subject ? ` for ${subject}` : "";
  if (total === 0) return `no expiry ${date}${of}; the chain lists no expiries`;
  return listed
    ? `no option contracts returned for${subject ? ` ${subject}` : ""} expiry ${date}; nearest others: ${choices}`
    : `no expiry ${date}${of}; available: ${choices}`;
}
