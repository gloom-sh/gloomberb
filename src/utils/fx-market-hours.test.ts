import { expect, test } from "bun:test";
import { fxFreshUntil, isFxMarketOpen } from "./fx-market-hours";

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
