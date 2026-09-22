import type { PricePoint } from "../../../types/financials";
import { canonicalExchange, resolveExchangeTimeZone } from "../../../utils/exchanges";
import { getPricePointTimestamp } from "../../../utils/price-history";
import type { DatedReturn } from "./metrics";

const DAY_MS = 86_400_000;
const sessionClocks = new Map<string, Intl.DateTimeFormat>();
// Cboe's US equity exchanges (BZX/BATS) close on the same published US equity holidays and early closes.
const NYSE_VENUES = new Set(["NYSE", "AMEX", "ARCA", "NYSE NATIONAL", "NYSE CHICAGO", "NYSE TEXAS", "BATS", "CBOE"]);
const NYSE_EARLY_CLOSES = new Set([
  "2025-07-03", "2025-11-28", "2025-12-24", "2026-11-27", "2026-12-24",
  "2027-11-26", "2028-07-03", "2028-11-24",
]);
const NASDAQ_EARLY_CLOSES = new Set(["2026-11-27", "2026-12-24"]);
// Published full closures, not a holiday-rule engine. Early closes are sessions.
const CLOSURES: Record<number, readonly string[]> = {
  2025: ["01-01", "01-09", "01-20", "02-17", "04-18", "05-26", "06-19", "07-04", "09-01", "11-27", "12-25"],
  2026: ["01-01", "01-19", "02-16", "04-03", "05-25", "06-19", "07-03", "09-07", "11-26", "12-25"],
  2027: ["01-01", "01-18", "02-15", "03-26", "05-31", "06-18", "07-05", "09-06", "11-25", "12-24"],
  2028: ["01-17", "02-21", "04-14", "05-29", "06-19", "07-04", "09-04", "11-23", "12-25"],
};

export const SHARPE_SESSION_BASIS = {
  checkedAt: "2026-09-12",
  nyse: {
    years: [2025, 2026, 2027, 2028],
    sources: [
      "https://ir.theice.com/press/news-details/2024/NYSE-Group-Announces-2025-2026-and-2027-Holiday-and-Early-Closings-Calendar/default.aspx",
      "https://www.nyse.com/trade/hours-calendars",
      "https://www.cboe.com/about/hours/us-equities/",
      "https://ir.theice.com/press/news-details/2024/The-New-York-Stock-Exchange-Will-Close-Markets-on-January-9-to-Honor-the-Passing-of-Former-President-Jimmy-Carter-on-National-Day-of-Mourning/default.aspx",
    ],
  },
  nasdaq: {
    years: [2025, 2026],
    sources: [
      "https://www.nasdaq.com/docs/2025/01/06/2025holidayandtradinghours.pdf",
      "https://www.nasdaqtrader.com/Trader.aspx?id=Calendar",
      "https://www.nasdaqtrader.com/TraderNews.aspx?id=ETA2024-87",
    ],
  },
  limitation: "Published schedules only; no live exceptional-closure feed or coverage for other venues/years.",
  timestampConvention: "Each source uses midnight-UTC date labels, a consistent declared-venue wall-clock time on the labelled date, or verified regular/early session-close timestamps.",
  actualCloseCoverage: "NYSE venues 2025–2028; Nasdaq 2026 only. Regular close 16:00 and listed early close 13:00 New York time.",
} as const;

export interface ReturnTimestampResult {
  supported: boolean;
  reason: string | null;
  issue?: { kind: string; symbol?: string; exchange?: string; date?: string; startDate?: string };
  sourceConventions?: { symbol: string; exchange: string; convention: string }[];
}

export interface SharpeCadenceResult extends ReturnTimestampResult {
  basis: typeof SHARPE_SESSION_BASIS;
}

export type TimestampHistory = { symbol: string; exchange: string; history: readonly PricePoint[] };

function dateTimestamp(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
}

function isSession(time: number): boolean {
  const date = new Date(time);
  const weekday = date.getUTCDay();
  return weekday !== 0 && weekday !== 6 && !CLOSURES[date.getUTCFullYear()]!.includes(date.toISOString().slice(5, 10));
}

/** Last verified session in a Monday-Friday week, or null outside published coverage. */
export function publishedWeekClose(friday: string, venue: string): string | null {
  const time = dateTimestamp(friday);
  if (time == null || new Date(time).getUTCDay() !== 5) return null;
  const exchange = canonicalExchange(venue);
  const years: readonly number[] = exchange === "NASDAQ" ? SHARPE_SESSION_BASIS.nasdaq.years
    : NYSE_VENUES.has(exchange) ? SHARPE_SESSION_BASIS.nyse.years : [];
  for (let offset = 0; offset < 5; offset++) {
    const candidate = time - offset * DAY_MS;
    if (!years.includes(new Date(candidate).getUTCFullYear())) return null;
    if (isSession(candidate)) return new Date(candidate).toISOString().slice(0, 10);
  }
  return null;
}

function timestampConventions(time: number, date: string, exchange: string): Set<string> {
  if (time % DAY_MS === 0) return new Set(["utc-date-label"]);
  const timeZone = NYSE_VENUES.has(exchange) ? "America/New_York" : resolveExchangeTimeZone(exchange);
  if (!timeZone) return new Set();
  let clock = sessionClocks.get(timeZone);
  if (!clock) {
    clock = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    sessionClocks.set(timeZone, clock);
  }
  const parts = new Map(clock.formatToParts(new Date(time)).map((part) => [part.type, part.value]));
  const localDate = `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
  if (localDate !== date) return new Set();
  const wallClock = `${parts.get("hour")}:${parts.get("minute")}:${parts.get("second")}.${new Date(time).getUTCMilliseconds()}`;
  // A consistent local label survives DST, unlike a fixed UTC-clock rule.
  const conventions = new Set([`local-clock:${wallClock}`]);
  const year = Number(date.slice(0, 4));
  const earlyCloses = NYSE_VENUES.has(exchange) && SHARPE_SESSION_BASIS.nyse.years.some((supportedYear) => supportedYear === year)
    ? NYSE_EARLY_CLOSES : exchange === "NASDAQ" && year === 2026 ? NASDAQ_EARLY_CLOSES : null;
  const day = dateTimestamp(date);
  if (earlyCloses && day != null && isSession(day) && wallClock === `${earlyCloses.has(date) ? "13" : "16"}:00:00.0`) {
    conventions.add("published-session-close");
  }
  return conventions;
}

/** Timestamp eligibility is independent of the calendar/frequency of intervals. */
export function qualifyReturnTimestamps(
  returns: readonly DatedReturn[],
  histories: readonly TimestampHistory[],
): ReturnTimestampResult {
  if (!returns.length || !histories.length) return { supported: false, reason: "Daily sample unavailable", issue: { kind: "empty-sample" } };
  const endpointDates = new Set(returns.flatMap((point) => [point.startDateKey, point.dateKey]));
  const sourceConventions: NonNullable<ReturnTimestampResult["sourceConventions"]> = [];
  for (const source of histories) {
    const exchange = canonicalExchange(source.exchange);
    const identity = { symbol: source.symbol, exchange };
    const observed = new Set(source.history.map(getPricePointTimestamp).filter(Number.isFinite));
    const dateTimes = new Map<string, number[]>();
    for (const time of observed) {
      const date = new Date(time).toISOString().slice(0, 10);
      dateTimes.set(date, [...(dateTimes.get(date) ?? []), time]);
    }
    let conventions: Set<string> | null = null;
    for (const date of endpointDates) {
      const times = dateTimes.get(date);
      if (times?.length !== 1) return { supported: false, reason: "Daily observations unavailable", issue: { ...identity, kind: "non-daily-observations", date } };
      const current = timestampConventions(times[0]!, date, exchange);
      conventions = conventions == null ? current : new Set([...conventions].filter((item: string) => current.has(item)));
      if (!conventions.size) return { supported: false, reason: "Daily timestamps unverified", issue: { ...identity, kind: "timestamp-convention", date } };
    }
    sourceConventions.push({ ...identity, convention: [...conventions!][0]! });
  }
  return { supported: true, reason: null, sourceConventions };
}

/** Qualify the whole unchanged sample; never drop Monday/holiday returns. */
export function qualifySharpeCadence(
  returns: readonly DatedReturn[],
  holdings: readonly TimestampHistory[],
  timestamps = qualifyReturnTimestamps(returns, holdings),
): SharpeCadenceResult {
  const failure = (reason: string, issue: NonNullable<SharpeCadenceResult["issue"]>): SharpeCadenceResult => (
    { supported: false, reason, issue, basis: SHARPE_SESSION_BASIS }
  );
  if (!returns.length || !holdings.length) return failure("Daily sample unavailable", { kind: "empty-sample" });
  if (!timestamps.supported) return { ...timestamps, basis: SHARPE_SESSION_BASIS };
  for (const holding of holdings) {
    // The declared listing venue supplies calendar identity; routing SMART does not.
    const exchange = canonicalExchange(holding.exchange);
    const years: readonly number[] | null = exchange === "NASDAQ" ? SHARPE_SESSION_BASIS.nasdaq.years
      : NYSE_VENUES.has(exchange) ? SHARPE_SESSION_BASIS.nyse.years : null;
    const identity = { symbol: holding.symbol, exchange };
    if (!years) return failure("Daily calendar unavailable", { ...identity, kind: "unsupported-venue" });
    for (const point of returns) {
      const start = dateTimestamp(point.startDateKey);
      const end = dateTimestamp(point.dateKey);
      const interval = { ...identity, startDate: point.startDateKey, date: point.dateKey };
      if (start == null || end == null || end <= start) return failure("Daily dates unavailable", { ...interval, kind: "invalid-date" });
      for (let year = new Date(start).getUTCFullYear(); year <= new Date(end).getUTCFullYear(); year++) {
        if (!years.includes(year)) return failure("Daily calendar unavailable", { ...interval, kind: "unsupported-year" });
      }
      if (!isSession(start) || !isSession(end)) return failure("Non-session price observations", { ...interval, kind: "closed-session" });
      for (let time = start + DAY_MS; time < end; time += DAY_MS) {
        if (isSession(time)) return failure("Non-daily return sample", { ...interval, kind: "missing-session" });
      }
    }
  }
  return { ...timestamps, basis: SHARPE_SESSION_BASIS };
}
