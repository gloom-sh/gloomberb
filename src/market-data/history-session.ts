import { canonicalHistoryInterval } from "../sources/history-retention";
import type { HistorySession } from "../types/price-history";
import { canonicalExchange, parsePublicTickerKey } from "../utils/exchanges";
import { getPublishedUsEquityCalendarYears, getPublishedUsEquitySession } from "./published-us-sessions";

const intervals = new Set(["1min", "5min", "15min", "30min", "1h"]);
const sourceKinds = new Set(["yahoo", "twelvedata", "alpaca"]);
const NY_CLOCK = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});
const DAY = 86_400_000;
const FEED_DELAY = 15 * 60_000;

/** Untrusted wire/cache metadata must match the actual requested listing and interval. */
export function parseHistorySession(
  value: unknown,
  expected?: { symbol: string; exchange: string; interval?: string },
  now = Date.now(),
): HistorySession | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || record.kind !== "regular" || record.calendar !== "us-equity"
    || record.timeZone !== "America/New_York" || typeof record.symbol !== "string"
    || !record.symbol || record.symbol.length > 256 || /[\r\n\0]/.test(record.symbol)
    || typeof record.exchange !== "string" || typeof record.source !== "string"
    || !sourceKinds.has(record.source)
    || (record.barAlignment !== "session-open" && record.barAlignment !== "clock")
    || (record.timestampConvention !== "bar-open"
      && !(record.timestampConvention === "bar-open-with-final-observation" && record.source === "yahoo"))
    || typeof record.observedAt !== "number" || !Number.isSafeInteger(record.observedAt)
    || record.observedAt <= 0 || record.observedAt > now) return null;
  const target = parsePublicTickerKey(record.symbol);
  const exchange = canonicalExchange(record.exchange);
  const interval = canonicalHistoryInterval(record.interval);
  if (target.exchange || target.symbol !== record.symbol || exchange !== record.exchange
    || !getPublishedUsEquityCalendarYears(exchange) || !interval || !intervals.has(interval)) return null;
  if (expected) {
    const wanted = parsePublicTickerKey(expected.symbol);
    const requestedExchange = canonicalExchange(expected.exchange);
    if (wanted.exchange && requestedExchange && wanted.exchange !== requestedExchange) return null;
    if (target.symbol !== wanted.symbol || exchange !== (wanted.exchange || canonicalExchange(expected.exchange))
      || (expected.interval !== undefined && interval !== canonicalHistoryInterval(expected.interval))) return null;
  }
  return { version: 1, kind: "regular", calendar: "us-equity", timeZone: "America/New_York",
    symbol: target.symbol, exchange, interval, source: record.source as HistorySession["source"],
    timestampConvention: record.timestampConvention, barAlignment: record.barAlignment, observedAt: record.observedAt };
}

function localDate(time: number): string {
  const parts = new Map(NY_CLOCK.formatToParts(new Date(time)).map(part => [part.type, part.value]));
  return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
}

function precedingSession(exchange: string, date: string) {
  const dateStart = Date.parse(`${date}T00:00:00Z`);
  for (let offset = 1; offset <= 10; offset++) {
    const previous = getPublishedUsEquitySession(exchange, new Date(dateStart - offset * DAY).toISOString().slice(0, 10));
    if (!previous) return null;
    if (previous.kind === "session") return previous;
  }
  return null;
}

/** null leaves an unsupported calendar/contract on the existing conservative path. */
export function regularHistorySessionStaleness(latestTime: number, now: number, metadata: HistorySession): boolean | null {
  const session = parseHistorySession(metadata, undefined, now);
  if (!session || !Number.isFinite(latestTime) || !Number.isFinite(now)) return null;
  if (latestTime > now || latestTime > session.observedAt) return true;
  const count = Number.parseInt(session.interval);
  const intervalMs = count * (session.interval.endsWith("h") ? 3_600_000 : 60_000);
  const allowedLag = Math.max(30 * 60_000, 2 * intervalMs + FEED_DELAY);
  const date = localDate(now);
  const today = getPublishedUsEquitySession(session.exchange, date);
  if (!today) return null;
  const isOpeningBar = (time: number, window: { open: number; close: number }) =>
    time >= window.open && time < window.close
    && (time - (session.barAlignment === "session-open" ? window.open : 0)) % intervalMs === 0;
  const isFinalObservation = (time: number, window: { close: number }) =>
    session.timestampConvention === "bar-open-with-final-observation" && time === window.close;
  let completed: { kind: "session"; open: number; close: number } | null;
  if (today.kind === "session" && now >= today.open && now < today.close) {
    if (latestTime >= today.open) return now - latestTime > allowedLag;
    // Previous closing history can answer until the first completed bar is due.
    const firstOpen = session.barAlignment === "session-open" ? today.open : Math.ceil(today.open / intervalMs) * intervalMs;
    if (now >= firstOpen + intervalMs + FEED_DELAY) return true;
    completed = precedingSession(session.exchange, date);
  } else if (today.kind === "session" && now >= today.close) {
    // Keep the normal feed/bar allowance immediately after the closing boundary.
    if (now <= today.close + FEED_DELAY && (isOpeningBar(latestTime, today) || isFinalObservation(latestTime, today))
      && now - latestTime <= allowedLag) return false;
    completed = today;
  } else {
    completed = precedingSession(session.exchange, date);
  }
  if (!completed) return null;
  const finalMarker = isFinalObservation(latestTime, completed);
  const terminalBar = isOpeningBar(latestTime, completed)
    && latestTime + intervalMs >= completed.close;
  // Opening-time bars may still be partial during the declared feed allowance.
  // The verified native closing observation separately establishes an actual close.
  return finalMarker ? session.observedAt < completed.close
    : session.observedAt < completed.close + FEED_DELAY || !terminalBar;
}
