import { expect, test } from "bun:test";
import { currentFxClosureStart, fxFreshUntil, isFxMarketOpen, latestFxWeekClose } from "./fx-market-hours";

const at = (iso: string) => Date.parse(iso);
const minutes = (count: number) => count * 60_000;

test("the FX week runs from Sunday 17:00 to Friday 17:00 New York, across daylight saving", () => {
  // EDT: 17:00 New York is 21:00 UTC.
  expect(isFxMarketOpen(at("2026-09-25T20:59:00Z"))).toBe(true);
  expect(isFxMarketOpen(at("2026-09-25T21:00:00Z"))).toBe(false);
  expect(isFxMarketOpen(at("2026-09-27T20:59:00Z"))).toBe(false);
  expect(isFxMarketOpen(at("2026-09-27T21:00:00Z"))).toBe(true);
  // EST: 17:00 New York is 22:00 UTC.
  expect(isFxMarketOpen(at("2026-11-06T21:30:00Z"))).toBe(true);
  expect(isFxMarketOpen(at("2026-11-08T21:30:00Z"))).toBe(false);
});

test("an FX observation ages only while the market is open", () => {
  // Midweek the window is plain elapsed time.
  expect(fxFreshUntil(at("2026-09-23T10:30:00Z"), minutes(75))).toBe(at("2026-09-23T11:45:00Z"));
  // Friday's last print keeps the rest of its window for Sunday's open.
  expect(fxFreshUntil(at("2026-09-25T20:59:00Z"), minutes(75))).toBe(at("2026-09-27T22:14:00Z"));
  expect(fxFreshUntil(at("2026-09-26T15:00:00Z"), minutes(60))).toBe(at("2026-09-27T22:00:00Z"));
  // A rate that stopped updating Friday morning is stale before the close.
  expect(fxFreshUntil(at("2026-09-25T14:00:00Z"), minutes(60))).toBe(at("2026-09-25T15:00:00Z"));
  // The weekend daylight saving ends: Friday closes 21:00 UTC, Sunday opens 22:00 UTC.
  expect(fxFreshUntil(at("2026-10-30T20:59:00Z"), minutes(75))).toBe(at("2026-11-01T23:14:00Z"));
});

test("the latest week close is Friday 17:00 New York at or before the time, whether or not the market trades", () => {
  expect(latestFxWeekClose(at("2026-10-09T21:00:00Z"))).toBe(at("2026-10-09T21:00:00Z"));
  expect(latestFxWeekClose(at("2026-10-09T20:59:00Z"))).toBe(at("2026-10-02T21:00:00Z"));
  expect(latestFxWeekClose(at("2026-10-10T14:50:00Z"))).toBe(at("2026-10-09T21:00:00Z"));
  expect(latestFxWeekClose(at("2026-10-13T14:00:00Z"))).toBe(at("2026-10-09T21:00:00Z"));
  // Standard time: 17:00 New York is 22:00 UTC.
  expect(latestFxWeekClose(at("2026-11-07T12:00:00Z"))).toBe(at("2026-11-06T22:00:00Z"));
});

test("a closure began at the latest week close, and there is none while the market trades", () => {
  const friday = at("2026-10-09T21:00:00Z");
  expect(currentFxClosureStart(friday)).toBe(friday);
  expect(currentFxClosureStart(at("2026-10-10T14:50:00Z"))).toBe(friday);
  expect(currentFxClosureStart(at("2026-10-11T20:59:00Z"))).toBe(friday);
  expect(currentFxClosureStart(at("2026-10-09T20:59:00Z"))).toBeNull();
  expect(currentFxClosureStart(at("2026-10-11T21:00:00Z"))).toBeNull();
  expect(currentFxClosureStart(Number.NaN)).toBeNull();
});

test("every minute of a closure, around both daylight saving changes, belongs to the Friday that opened it", () => {
  // [Friday close, Sunday reopen] in UTC. US time ends Sun 1 Nov 2026 and starts Sun 14 Mar 2027.
  const closures: [string, string][] = [
    ["2026-10-30T21:00:00Z", "2026-11-01T22:00:00Z"],
    ["2027-03-12T22:00:00Z", "2027-03-14T21:00:00Z"],
    ["2027-03-19T21:00:00Z", "2027-03-21T21:00:00Z"],
  ];
  for (const [closed, reopened] of closures) {
    expect(isFxMarketOpen(at(closed) - 1)).toBe(true);
    expect(isFxMarketOpen(at(closed))).toBe(false);
    expect(isFxMarketOpen(at(reopened) - 1)).toBe(false);
    expect(isFxMarketOpen(at(reopened))).toBe(true);
    for (let time = at(closed); time < at(reopened); time += minutes(1)) {
      if (currentFxClosureStart(time) !== at(closed) || latestFxWeekClose(time) !== at(closed)) {
        throw new Error(`${new Date(time).toISOString()} is not in the closure that began ${closed}`);
      }
    }
    expect(currentFxClosureStart(at(reopened))).toBeNull();
  }
});
