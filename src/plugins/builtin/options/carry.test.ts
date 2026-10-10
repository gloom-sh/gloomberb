import { describe, expect, test } from "bun:test";
import { formatCarryPercent, optionCarry, optionSpreadPercent } from "./carry";

// 2028-01-21; valued from 2026-10-09 16:00 New York, 469 days and the hour daylight saving gives back before its close.
const EXPIRATION = Date.UTC(2028, 0, 21) / 1000;
const NOW = Date.parse("2026-10-09T20:00:00Z");
const YEARS = (469 + 1 / 24) / 365;

const quote = (strike: number, bid: number, ask: number, expiration = EXPIRATION) => ({ strike, bid, ask, expiration });

describe("optionCarry", () => {
  test("is the midpoint less intrinsic, as a share of spot per year, for a call and a put", () => {
    const call = optionCarry(quote(600, 209.4, 211.5), "call", 717.6, NOW)!;
    expect(call.extrinsic).toBeCloseTo(210.45 - 117.6, 10);
    expect(call.extrinsicPerYear).toBeCloseTo((210.45 - 117.6) / 717.6 / YEARS, 10);

    // An out-of-the-money put is all time value; an in-the-money one is measured past intrinsic.
    expect(optionCarry(quote(500, 27.3, 28.2), "put", 717.6, NOW)!.extrinsic).toBeCloseTo(27.75, 10);
    expect(optionCarry(quote(900, 225.65, 229.4), "put", 717.6, NOW)!.extrinsic).toBeCloseTo(227.525 - 182.4, 10);
  });

  test("keeps a midpoint below intrinsic as negative time value rather than flooring it", () => {
    const carry = optionCarry(quote(100, 615, 619), "call", 717.6, NOW)!;
    expect(carry.extrinsic).toBeCloseTo(-0.6, 10);
    expect(carry.extrinsicPerYear!).toBeLessThan(0);
  });

  test("has no figure without a two-sided quote or a current spot", () => {
    // Zero bid, one-sided (no ask), crossed, and no quote at all.
    for (const [bid, ask] of [[0, 1.2], [1.2, 0], [2, 1.5], [0, 0]] as const) {
      expect(optionCarry(quote(600, bid, ask), "call", 717.6, NOW)).toBeNull();
    }
    expect(optionCarry(quote(600, 209.4, 211.5), "call", undefined, NOW)).toBeNull();
    expect(optionCarry(quote(600, 209.4, 211.5), "call", 0, NOW)).toBeNull();
  });

  test("reads the time value under a day from expiry but no yearly rate, which would be noise", () => {
    const expiringToday = quote(600, 118, 119, Date.UTC(2026, 9, 9) / 1000);
    // One minute before the close: 0.9 over a minute would read as millions of percent a year.
    expect(optionCarry(expiringToday, "call", 717.6, Date.parse("2026-10-09T19:59:00Z"))).toEqual({ extrinsic: expect.closeTo(0.9, 10), extrinsicPerYear: null });
    expect(optionCarry(expiringToday, "call", 717.6, Date.parse("2026-10-10T12:00:00Z"))!.extrinsicPerYear).toBeNull();
    // A day out it is a rate again.
    expect(optionCarry(expiringToday, "call", 717.6, Date.parse("2026-10-08T20:00:00Z"))!.extrinsicPerYear).toBeCloseTo(0.9 / 717.6 * 365, 10);
  });
});

test("optionSpreadPercent is the width over the midpoint, and only for a two-sided quote", () => {
  expect(optionSpreadPercent({ bid: 9.5, ask: 10.5 })).toBeCloseTo(10, 10);
  expect(optionSpreadPercent({ bid: 0, ask: 0.05 })).toBeNull();
  expect(optionSpreadPercent({ bid: 1, ask: 0 })).toBeNull();
  expect(optionSpreadPercent({ bid: 2, ask: 1 })).toBeNull();
});

test("formatCarryPercent keeps one decimal where it reads and drops it past 100%", () => {
  expect([0.0421, -0.003, 1.234, null].map(formatCarryPercent)).toEqual(["4.2%", "-0.3%", "123%", "—"]);
});
