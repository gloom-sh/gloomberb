import type { CorporateActionsData, DeclaredDividendAction, Fundamentals } from "../types/financials";
import { declaredDividends } from "./declared-dividends";
import { formatDistributionAmount } from "./format";

/**
 * What a forward dividend yield is everywhere it shows (fundamentals, DVD,
 * EQS): the indicated annual rate Gloom Cloud serves over the price, dated by
 * the ex-date of the distribution it annualizes. While no other is announced
 * that is the latest distribution, whose ex-date has passed. Once the next one
 * is declared the rate annualizes it, and its ex-date is still ahead: the
 * basis then names the declared distribution by its ex-date and pay date, and
 * by its amount when Gloom Cloud states one for that ex-date, never a rate "as
 * of" a day that has not come. The amount is only ever the stated one, never
 * the rate divided back.
 */
export const LATEST_DISTRIBUTION = "latest distribution annualized";

/**
 * What a trailing dividend yield is everywhere it shows (DVD, a fund's in
 * fundamentals, EQS): the distributions that went ex in the last twelve months
 * over the price, so it differs from the forward yield whenever the latest
 * distribution is not the year's usual one.
 */
export const TRAILING_DIVIDEND_BASIS = "last 12 months of distributions";

/** `2026-10-01` from a date or an ISO text; null when it is neither. */
function isoDay(value: string | Date | null | undefined): string | null {
  const text = value instanceof Date ? (Number.isFinite(value.getTime()) ? value.toISOString() : "") : value ?? "";
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

/** A rate dated by an ex-date after today annualizes a distribution declared and not yet gone ex. */
function isDeclared(exDate: string | null, now: Date): exDate is string {
  return exDate != null && exDate > now.toISOString().slice(0, 10);
}

interface DeclaredBasisOptions {
  /** The declared distributions Gloom Cloud states (`declaredDividends`); only the one on the rate's ex-date counts. */
  declared?: readonly DeclaredDividendAction[];
  /** The currency their amounts are in; without it no amount is named. */
  currency?: string | null;
  now?: Date;
}

/** The declared row on the rate's ex-date, as `$0.98`, with its pay date; null when none is stated. */
function statedDeclaration(exDate: string, options: DeclaredBasisOptions): { amount: string; payDate: string | null } | null {
  const row = options.currency ? options.declared?.find((declared) => declared.exDate === exDate) : undefined;
  return row ? { amount: formatDistributionAmount(row.amount, options.currency!), payDate: isoDay(row.payDate) } : null;
}

/**
 * `latest distribution annualized, as of 2026-08-20`, or for a rate dated
 * ahead, `annualized from the declared $0.98 payable 2026-12-10, ex
 * 2026-11-19`, the amount and pay date when they are stated; the basis alone
 * when the date is unknown. `payDate` is the pay date a source states beside
 * that ex-date without a declared row (DVD's summary).
 */
export function forwardDividendBasis(
  asOf: string | Date | null | undefined,
  options: DeclaredBasisOptions & { payDate?: string | Date | null } = {},
): string {
  const exDate = isoDay(asOf);
  if (!isDeclared(exDate, options.now ?? new Date())) return exDate ? `${LATEST_DISTRIBUTION}, as of ${exDate}` : LATEST_DISTRIBUTION;
  const stated = statedDeclaration(exDate, options);
  const payDate = stated?.payDate ?? isoDay(options.payDate);
  return `annualized from the declared ${stated?.amount ?? "distribution"}${payDate ? ` payable ${payDate}` : ""}, ex ${exDate}`;
}

const DAY_MS = 86_400_000;

/** The usual intervals between distributions, in days: monthly, quarterly, semiannual and annual. */
const CADENCE_DAYS = [365.25 / 12, 365.25 / 4, 365.25 / 2, 365.25] as const;
/** The interval is read from the gaps between the last four distributions in the two years up to the latest. */
const CADENCE_GAPS = 3;
const CADENCE_SPAN_DAYS = 2 * 365.25;
/** Half an interval of grace for a late distribution, kept between a month and three months. */
const MIN_GRACE_DAYS = 30;
const MAX_GRACE_DAYS = 90;
/**
 * With fewer than two distributions to read an interval from, the window an
 * annual payer gets: fifteen months, after which Gloom Cloud withdraws a
 * lapsed forward yield too.
 */
const UNKNOWN_CADENCE_WINDOW_DAYS = 455;
/** The shortest a dividend can take to lapse: a monthly payer's interval and grace. */
const SHORTEST_WINDOW_DAYS = CADENCE_DAYS[0] + MIN_GRACE_DAYS;

function dayNumber(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) / DAY_MS;
}

/**
 * The issuer's usual interval between distributions in days, read from its
 * own ex-dates: the longest of the last three gaps between them in the two
 * years up to the latest, as the nearest of monthly, quarterly, semiannual and
 * annual. The longest, so a special distribution between two regular ones
 * does not shorten it, and a payer that moved to a longer schedule is read on
 * the new one. One gap alone may be a regular and a special distribution, so
 * with two ex-dates it is at least quarterly. Null with fewer than two in that
 * span.
 */
function distributionIntervalDays(exDates: readonly (string | Date)[]): number | null {
  const days = [...new Set(exDates.flatMap((value) => {
    const day = isoDay(value);
    return day ? [dayNumber(day)] : [];
  }))].sort((left, right) => left - right);
  const latest = days.at(-1);
  if (latest == null) return null;
  const recent = days.filter((day) => day >= latest - CADENCE_SPAN_DAYS).slice(-(CADENCE_GAPS + 1));
  if (recent.length < 2) return null;
  const longest = Math.max(...recent.slice(1).map((day, index) => day - recent[index]!));
  const nearest = CADENCE_DAYS.reduce<number>((best, cadence) =>
    Math.abs(Math.log(longest / cadence)) < Math.abs(Math.log(longest / best)) ? cadence : best, CADENCE_DAYS[0]);
  return recent.length < 3 ? Math.max(nearest, CADENCE_DAYS[1]) : nearest;
}

/** A dividend that has stopped: no forward yield, only the day the last distribution went ex. */
export interface DividendLapse {
  /** YYYY-MM-DD; null when no date is known. */
  lastPaid: string | null;
}

/** What a forward yield is checked against: the issuer's own distributions. */
export interface DistributionHistory {
  /** Ex-dates of the paid distributions; null when the history is unknown. */
  exDates: readonly (string | Date)[] | null;
  /** Declared and still owed (declaredDividends); one keeps the dividend current. */
  declared?: readonly Pick<DeclaredDividendAction, "exDate">[];
}

/**
 * A corporate actions payload as the history a forward yield is checked
 * against; its ex-dates are unknown when it does not cover dividends or was
 * served stale, which could leave out a recent distribution.
 */
export function distributionHistory(actions: CorporateActionsData | null | undefined, now = new Date()): DistributionHistory | null {
  if (!actions) return null;
  const current = actions.coverage?.dividends === "available" && actions.stale !== true;
  return { exDates: current ? actions.dividends.map((dividend) => dividend.exDate) : null, declared: declaredDividends(actions, now) };
}

/**
 * Whether the dividend behind a forward rate dated `asOf` (the ex-date of the
 * distribution it annualizes) has stopped. It is current while its latest
 * distribution went ex within its usual interval plus grace: half an interval,
 * at least a month and at most three, so a monthly payer lapses about two
 * months after its last ex-date, a quarterly one after four and a half months,
 * a semiannual one after nine and an annual one after fifteen (the window
 * Gloom Cloud uses). The interval comes from the issuer's own history, at
 * least quarterly when it has only two distributions; without one (fewer than
 * two distributions, or no history) the annual window applies.
 * A distribution declared and not yet ex, the rate's own or one in the
 * history, keeps it current. Null while current or when nothing is known.
 */
export function lapsedDividend(
  asOf: string | Date | null | undefined,
  history: DistributionHistory | null | undefined,
  now = new Date(),
): DividendLapse | null {
  const today = isoDay(now)!;
  const days = [...history?.exDates ?? [], asOf].flatMap((value) => {
    const day = isoDay(value);
    return day ? [day] : [];
  });
  if (days.some((day) => day > today) || (history?.declared?.length ?? 0) > 0) return null;
  const paid = [...new Set(days)];
  if (paid.length === 0) return null;
  const lastPaid = paid.reduce((latest, day) => (day > latest ? day : latest));
  const interval = history?.exDates ? distributionIntervalDays(paid) : null;
  const window = interval == null ? UNKNOWN_CADENCE_WINDOW_DAYS
    : interval + Math.min(MAX_GRACE_DAYS, Math.max(MIN_GRACE_DAYS, interval / 2));
  return dayNumber(today) - dayNumber(lastPaid) > window ? { lastPaid } : null;
}

/**
 * Whether a forward rate dated `asOf` could have lapsed by `now`, so the
 * history is worth reading: never while its ex-date is ahead or more recent
 * than the shortest window, a monthly payer's.
 */
export function forwardDividendMayHaveLapsed(asOf: string | Date | null | undefined, now = new Date()): boolean {
  const rateDay = isoDay(asOf);
  return !rateDay || dayNumber(isoDay(now)!) - dayNumber(rateDay) > SHORTEST_WINDOW_DAYS;
}

/**
 * Whether a listing's forward yield is old enough to have lapsed, so its
 * distribution history is worth reading; never for a trailing yield or none.
 */
export function forwardYieldMayHaveLapsed(
  fundamentals: Pick<Fundamentals, "dividendYieldBasis" | "exDividendDate"> | null | undefined,
  now = new Date(),
): boolean {
  return fundamentals?.dividendYieldBasis === "forward" && forwardDividendMayHaveLapsed(fundamentals.exDividendDate, now);
}

export const NO_CURRENT_DIVIDEND = "no current dividend";

/** `last paid 2026-02-27`, the note beside "no current dividend"; null when the date is unknown. */
export function lastPaidNote(lapse: DividendLapse): string | null {
  return lapse.lastPaid ? `last paid ${lapse.lastPaid}` : null;
}

/** `no current dividend (last paid 2026-02-27)`, what a lapsed forward yield reads instead of a percentage. */
export function noCurrentDividend(lapse: DividendLapse): string {
  const note = lastPaidNote(lapse);
  return note ? `${NO_CURRENT_DIVIDEND} (${note})` : NO_CURRENT_DIVIDEND;
}

/** The same basis as a pane's short note under the figure: `as of 2026-08-20`, or `declared $0.98` beside the next ex-date it shows. */
export function forwardDividendNote(asOf: string | Date | null | undefined, options: DeclaredBasisOptions = {}): string | null {
  const exDate = isoDay(asOf);
  if (!exDate) return null;
  if (!isDeclared(exDate, options.now ?? new Date())) return `as of ${exDate}`;
  const stated = statedDeclaration(exDate, options);
  return stated ? `declared ${stated.amount}` : "declared";
}
