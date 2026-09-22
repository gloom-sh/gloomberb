import type { PricePoint } from "../../../types/financials";
import { canonicalExchange, resolveExchangeTimeZone } from "../../../utils/exchanges";
import { getPricePointTimestamp } from "../../../utils/price-history";
import type { DatedReturn } from "./metrics";
import { getPublishedUsEquityCalendarDay, getPublishedUsEquityCalendarYears, getPublishedUsEquitySession, PUBLISHED_US_EQUITY_SESSION_BASIS } from "../../../market-data/published-us-sessions";

const DAY_MS = 86_400_000;
const sessionClocks = new Map<string, Intl.DateTimeFormat>();
export const SHARPE_SESSION_BASIS = {
  ...PUBLISHED_US_EQUITY_SESSION_BASIS,
  timestampConvention: "Each source uses midnight-UTC date labels, a consistent declared-venue wall-clock time on the labelled date, or verified regular/early session-close timestamps.",
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

function isSession(time: number, exchange: string): boolean {
  return getPublishedUsEquityCalendarDay(exchange, new Date(time).toISOString().slice(0, 10)) === "session";
}

/** Last verified session in a Monday-Friday week, or null outside published coverage. */
export function publishedWeekClose(friday: string, venue: string): string | null {
  const time = dateTimestamp(friday);
  if (time == null || new Date(time).getUTCDay() !== 5) return null;
  const exchange = canonicalExchange(venue);
  const years = getPublishedUsEquityCalendarYears(exchange) ?? [];
  for (let offset = 0; offset < 5; offset++) {
    const candidate = time - offset * DAY_MS;
    if (!years.includes(new Date(candidate).getUTCFullYear())) return null;
    if (isSession(candidate, exchange)) return new Date(candidate).toISOString().slice(0, 10);
  }
  return null;
}

function timestampConventions(time: number, date: string, exchange: string): Set<string> {
  if (time % DAY_MS === 0) return new Set(["utc-date-label"]);
  const timeZone = getPublishedUsEquityCalendarYears(exchange) ? "America/New_York" : resolveExchangeTimeZone(exchange);
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
  const session = getPublishedUsEquitySession(exchange, date);
  if (session?.kind === "session" && time === session.close) conventions.add("published-session-close");
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
    const years = getPublishedUsEquityCalendarYears(exchange);
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
      if (!isSession(start, exchange) || !isSession(end, exchange)) return failure("Non-session price observations", { ...interval, kind: "closed-session" });
      for (let time = start + DAY_MS; time < end; time += DAY_MS) {
        if (isSession(time, exchange)) return failure("Non-daily return sample", { ...interval, kind: "missing-session" });
      }
    }
  }
  return { ...timestamps, basis: SHARPE_SESSION_BASIS };
}
