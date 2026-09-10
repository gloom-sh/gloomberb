import { describe, expect, test } from "bun:test";
import { getActiveQuoteDisplay, marketStateCountdown } from "./status";

describe("marketStateCountdown", () => {
  test("adds precision as the US session boundary approaches", () => {
    expect(marketStateCountdown("PRE", Date.parse("2026-08-18T12:21:42Z"))).toBe("1h 9m");
    expect(marketStateCountdown("PRE", Date.parse("2026-08-18T13:25:09Z"))).toBe("4m 51s");
    expect(marketStateCountdown("REGULAR", Date.parse("2026-08-18T18:59:59Z"))).toBeNull();
    expect(marketStateCountdown("REGULAR", Date.parse("2026-08-18T19:00:00Z"))).toBe("1h");
    expect(marketStateCountdown("REGULAR", Date.parse("2026-08-18T19:50:42Z"))).toBe("9m 18s");
  });
});


test("active after-hours price keeps daily change against previous close, including a regular-only primary quote", () => {
  const quote = { symbol: "NVDA", currency: "USD", price: 218.36, change: -5.31, changePercent: -2.374,
    previousClose: 223.67, marketState: "POST" as const, postMarketPrice: 218.47,
    postMarketChange: 0.11, postMarketChangePercent: 0.0503755266532, lastUpdated: 1789072245412 };
  const active = getActiveQuoteDisplay(quote)!;
  expect(active.price).toBe(218.47);
  expect(active.change).toBeCloseTo(-5.2, 8);
  expect(active.changePercent).toBeCloseTo(-2.324853578933245, 8);
  for (const previousClose of [undefined, 0, Number.NaN]) {
    expect(getActiveQuoteDisplay({ ...quote, previousClose })).toEqual({ price: 218.47, change: undefined, changePercent: undefined });
  }
});
