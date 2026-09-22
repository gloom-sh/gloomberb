import { expect, test } from "bun:test";
import type { HistorySession } from "../types/price-history";
import { parseHistorySession, regularHistorySessionStaleness } from "./history-session";

const time = (value: string) => Date.parse(value);
const NOW = time("2026-09-22T12:42:00Z");
const metadata = (overrides: Partial<HistorySession> = {}): HistorySession => ({
  version: 1, kind: "regular", calendar: "us-equity", timeZone: "America/New_York",
  symbol: "AAPL", exchange: "NASDAQ", interval: "15min", source: "yahoo",
  timestampConvention: "bar-open", barAlignment: "session-open", observedAt: NOW, ...overrides,
});
function stale(latest: string, now: string, overrides: Partial<HistorySession> = {}) {
  return regularHistorySessionStaleness(time(latest), time(now), metadata({ observedAt: time(now), ...overrides }));
}

test("session metadata binds a canonical listing, supported cadence and source convention without changing its acquisition clock", () => {
  const original = metadata({ observedAt: time("2026-09-21T20:05:00Z") });
  const snapshot = JSON.stringify(original);
  expect(parseHistorySession(original, { symbol: "aapl:NMS", exchange: "NASDAQ", interval: "15m" }, NOW)).toEqual(original);
  expect(JSON.stringify(original)).toBe(snapshot);
  expect(parseHistorySession(original, { symbol: "MSFT", exchange: "NASDAQ", interval: "15m" }, NOW)).toBeNull();
  expect(parseHistorySession(original, { symbol: "AAPL", exchange: "NYSE", interval: "15m" }, NOW)).toBeNull();
  expect(parseHistorySession(original, { symbol: "AAPL", exchange: "NASDAQ", interval: "5m" }, NOW)).toBeNull();
  for (const override of [
    { version: 2 }, { kind: "extended" }, { calendar: "24x7" }, { timeZone: "UTC" },
    { symbol: "AAPL:NASDAQ" }, { symbol: "aapl" }, { symbol: "AAPL\n" }, { exchange: "NASDAQGS" },
    { exchange: "SMART" }, { exchange: "CCC" }, { exchange: "LSE" }, { source: "ibkr" }, { source: "unknown" },
    { interval: "2m" }, { interval: "60m" }, { interval: "1d" }, { interval: "1wk" }, { interval: "auto" },
    { timestampConvention: "bar-close" }, { barAlignment: undefined }, { barAlignment: "unknown" }, { source: "alpaca", timestampConvention: "bar-open-with-final-observation" },
    { observedAt: NOW + 1 }, { observedAt: 0 }, { observedAt: -1 }, { observedAt: NaN },
    { observedAt: Infinity }, { observedAt: NOW - 0.5 }, { observedAt: String(NOW) },
  ]) expect(parseHistorySession({ ...original, ...override }, undefined, NOW)).toBeNull();
  expect(parseHistorySession(metadata({ timestampConvention: "bar-open-with-final-observation" }), undefined, NOW)?.timestampConvention)
    .toBe("bar-open-with-final-observation");
  for (const value of [undefined, null, [], "regular"]) expect(parseHistorySession(value, undefined, NOW)).toBeNull();
});

test("conflicting requested listing declarations cannot authorize a session exemption", () => {
  expect(parseHistorySession(metadata({ exchange: "NYSE" }), { symbol: "AAPL:NYSE", exchange: "NASDAQ", interval: "15m" }, NOW)).toBeNull();
});

test("a terminal prior-session bar remains usable overnight and pre-open while a midday tail or unfinished acquisition does not", () => {
  // September 21 closes at 20:00 UTC (16:00 New York); September 22 opens at 13:30 UTC.
  for (const now of ["2026-09-21T22:00:00Z", "2026-09-22T06:00:00Z", "2026-09-22T12:42:00Z"]) {
    expect(stale("2026-09-21T19:45:00Z", now)).toBe(false);
    expect(stale("2026-09-21T16:00:00Z", now)).toBe(true);
    expect(stale("2026-09-21T19:45:00Z", now, { observedAt: time("2026-09-21T19:50:00Z") })).toBe(true);
    expect(stale("2026-09-21T19:45:00Z", now, { observedAt: time("2026-09-21T20:00:00Z") })).toBe(true);
    expect(stale("2026-09-21T19:45:00Z", now, { observedAt: time("2026-09-21T20:15:00Z") })).toBe(false);
  }
  expect(stale("2026-09-21T19:45:00Z", "2026-09-22T12:42:00Z", { observedAt: time("2026-09-21T19:44:00Z") })).toBe(true);
  expect(stale("2026-09-22T13:00:00Z", "2026-09-22T12:42:00Z")).toBe(true);
});

test("the immediately preceding scheduled session accounts for weekends, holidays and exceptional closures", () => {
  for (const now of ["2026-09-19T12:00:00Z", "2026-09-20T18:00:00Z", "2026-09-21T12:42:00Z"]) {
    expect(stale("2026-09-18T19:45:00Z", now)).toBe(false);
    expect(stale("2026-09-17T19:45:00Z", now)).toBe(true);
  }
  // Monday September 7 is Labor Day; the previous session is Friday September 4.
  for (const now of ["2026-09-07T18:00:00Z", "2026-09-08T12:42:00Z"]) {
    expect(stale("2026-09-04T19:45:00Z", now)).toBe(false);
    expect(stale("2026-09-03T19:45:00Z", now)).toBe(true);
  }
  for (const now of ["2025-01-09T18:00:00Z", "2025-01-10T13:42:00Z"]) {
    expect(stale("2025-01-08T20:45:00Z", now, { exchange: "NYSE" })).toBe(false);
    expect(stale("2025-01-07T20:45:00Z", now, { exchange: "NYSE" })).toBe(true);
  }
});

test("early closes and both DST weekends use exchange-local terminal bars without inventing missing session tails", () => {
  for (const now of ["2026-11-27T19:00:00Z", "2026-11-30T13:42:00Z"]) {
    expect(stale("2026-11-27T17:45:00Z", now)).toBe(false);
    expect(stale("2026-11-27T17:30:00Z", now)).toBe(true);
    expect(stale("2026-11-25T20:45:00Z", now)).toBe(true);
  }
  // Spring Friday close is 21:00 UTC; the following Monday opens at 13:30 UTC.
  expect(stale("2026-03-06T20:45:00Z", "2026-03-09T12:42:00Z")).toBe(false);
  expect(stale("2026-03-06T19:45:00Z", "2026-03-09T12:42:00Z")).toBe(true);
  // Autumn Friday close is 20:00 UTC; the following Monday opens at 14:30 UTC.
  expect(stale("2026-10-30T19:45:00Z", "2026-11-02T13:42:00Z")).toBe(false);
  expect(stale("2026-10-30T18:45:00Z", "2026-11-02T13:42:00Z")).toBe(true);
});

test("cadence-specific terminal bars and the declared native final-observation marker remain distinct", () => {
  for (const [interval, last, missingTail] of [
    ["1min", "19:59", "19:58"], ["5min", "19:55", "19:50"],
    ["15min", "19:45", "19:30"], ["1h", "19:30", "18:30"],
  ] as const) {
    expect(stale(`2026-09-21T${last}:00Z`, "2026-09-22T12:42:00Z", { interval })).toBe(false);
    expect(stale(`2026-09-21T${missingTail}:00Z`, "2026-09-22T12:42:00Z", { interval })).toBe(true);
  }
  expect(stale("2026-09-21T20:00:00Z", "2026-09-22T12:42:00Z")).toBe(true);
  expect(stale("2026-09-21T20:00:00Z", "2026-09-22T12:42:00Z", { timestampConvention: "bar-open-with-final-observation" })).toBe(false);
  expect(stale("2026-11-27T18:00:00Z", "2026-11-30T13:42:00Z", { timestampConvention: "bar-open-with-final-observation" })).toBe(false);
  expect(stale("2026-11-27T18:00:01Z", "2026-11-30T13:42:00Z", { timestampConvention: "bar-open-with-final-observation" })).toBe(true);
});

test("an unaligned native current observation is not a completed closing bar even if adding its interval would cross the close", () => {
  expect(stale("2026-09-21T19:59:00Z", "2026-09-22T12:42:00Z", { timestampConvention: "bar-open-with-final-observation" })).toBe(true);
  expect(stale("2026-11-27T17:59:00Z", "2026-11-30T13:42:00Z", { timestampConvention: "bar-open-with-final-observation" })).toBe(true);
  expect(stale("2026-09-21T19:59:00Z", "2026-09-22T12:42:00Z")).toBe(true);
  // The verified source paths can use whole-hour or session-open alignment;
  // both terminal opening bars cover the 16:00 close, while an arbitrary minute does not.
  expect(stale("2026-09-21T19:00:00Z", "2026-09-22T12:42:00Z", { interval: "1h", barAlignment: "clock" })).toBe(false);
  expect(stale("2026-09-21T19:30:00Z", "2026-09-22T12:42:00Z", { interval: "1h" })).toBe(false);
  expect(stale("2026-09-21T19:31:00Z", "2026-09-22T12:42:00Z", { interval: "1h" })).toBe(true);
});

test("previous-session history expires when the first completed bar is due and current-session cadence allowance stays bounded", () => {
  for (const [interval, beforeDue, due] of [
    ["1min", "13:45:59", "13:46:00"], ["5min", "13:49:59", "13:50:00"],
    ["15min", "13:59:59", "14:00:00"], ["1h", "14:44:59", "14:45:00"],
  ] as const) {
    const terminal = interval === "1min" ? "19:59" : interval === "5min" ? "19:55" : interval === "1h" ? "19:30" : "19:45";
    expect(stale(`2026-09-21T${terminal}:00Z`, `2026-09-22T${beforeDue}Z`, { interval })).toBe(false);
    expect(stale(`2026-09-21T${terminal}:00Z`, `2026-09-22T${due}Z`, { interval })).toBe(true);
  }
  expect(stale("2026-09-22T13:30:00Z", "2026-09-22T14:15:00Z")).toBe(false);
  expect(stale("2026-09-22T13:30:00Z", "2026-09-22T14:15:01Z")).toBe(true);
  expect(stale("2026-09-22T13:30:00Z", "2026-09-22T14:00:01Z", { interval: "1min" })).toBe(true);
  // Whole-hour labels first open at10:00 New York; that full bar completes
  // at11:00 and is due at11:15, unlike a session-aligned9:30 opening bar.
  expect(stale("2026-09-21T19:00:00Z", "2026-09-22T15:14:59Z", { interval: "1h", barAlignment: "clock" })).toBe(false);
  expect(stale("2026-09-21T19:00:00Z", "2026-09-22T15:15:00Z", { interval: "1h", barAlignment: "clock" })).toBe(true);
});

test("post-close delivery grace does not authorize timestamps outside the declared regular session", () => {
  expect(stale("2026-09-21T19:30:00Z", "2026-09-21T20:05:00Z")).toBe(false);
  expect(stale("2026-09-21T19:30:00Z", "2026-09-21T20:15:01Z")).toBe(true);
  expect(stale("2026-09-21T20:01:00Z", "2026-09-21T20:05:00Z")).toBe(true);
  expect(stale("2026-09-21T20:00:00Z", "2026-09-21T20:05:00Z")).toBe(true);
  expect(stale("2026-09-21T20:00:00Z", "2026-09-21T20:05:00Z", { timestampConvention: "bar-open-with-final-observation" })).toBe(false);
  expect(stale("2026-11-27T18:01:00Z", "2026-11-27T18:05:00Z")).toBe(true);
});

test("unsupported calendars, intervals and continuous-market contracts cannot gain the regular-equity exemption", () => {
  for (const interval of ["2m", "1d", "1wk", "auto"]) {
    expect(stale("2026-09-21T19:45:00Z", "2026-09-22T12:42:00Z", { interval })).toBeNull();
  }
  for (const exchange of ["SMART", "BATS", "", "CCC", "CCY", "CME", "LSE"]) {
    expect(stale("2026-09-18T19:45:00Z", "2026-09-20T18:00:00Z", { exchange })).toBeNull();
  }
  expect(stale("2025-11-28T17:45:00Z", "2025-12-01T13:42:00Z")).toBeNull();
  expect(stale("2027-11-26T17:45:00Z", "2027-11-29T13:42:00Z")).toBeNull();
  expect(stale("2024-12-31T20:45:00Z", "2025-01-02T13:42:00Z", { exchange: "NYSE" })).toBeNull();
  expect(regularHistorySessionStaleness(NaN, NOW, metadata())).toBeNull();
  expect(regularHistorySessionStaleness(time("2026-09-21T19:45:00Z"), NOW, { ...metadata(), kind: "continuous" } as unknown as HistorySession)).toBeNull();
  expect(regularHistorySessionStaleness(time("2026-09-21T19:45:00Z"), NOW, { ...metadata(), source: "unknown" } as unknown as HistorySession)).toBeNull();
});
