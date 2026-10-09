import { describe, expect, test } from "bun:test";
import type { Quote } from "../../types/financials";
import {
  getActiveQuoteDisplay,
  getExtendedSessionDisplay,
  getRegularSessionDisplay,
  getSessionMoveDisplay,
  marketStateCountdown,
} from "./status";

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

describe("regular and extended session displays", () => {
  // SPCX on 2026-10-08 at 22:22Z: the quote's price and change are the after-hours print against the day before's close.
  const afterHours: Quote = {
    symbol: "SPCX", currency: "USD", price: 165.14, change: -2.46, changePercent: -1.4678,
    previousClose: 167.6, regularClose: 160.57, regularCloseSessionDate: "2026-10-08", changeSessionDate: "2026-10-08",
    marketState: "POST", postMarketPrice: 165.14, postMarketChange: 4.57, postMarketChangePercent: 2.846,
    listingExchangeName: "NASDAQ", lastUpdated: Date.parse("2026-10-08T22:22:00Z"),
  };
  // After 20:00 New York the after-hours fields are gone; the last print and the regular close stay.
  const overnight: Quote = {
    ...afterHours, marketState: "POSTPOST", price: 164.35, change: -3.25, changePercent: -1.939,
    postMarketPrice: undefined, postMarketChange: undefined, postMarketChangePercent: undefined,
    lastUpdated: Date.parse("2026-10-08T23:59:55Z"),
  };

  test("after the close the headline is the regular session and the extended line is the print against its close", () => {
    const regular = getRegularSessionDisplay(afterHours)!;
    expect(regular.price).toBe(160.57);
    expect(regular.change).toBeCloseTo(-7.03, 8);
    expect(regular.changePercent).toBeCloseTo(-4.1945, 3);
    const extended = getExtendedSessionDisplay(afterHours)!;
    expect(extended.session).toBe("POST");
    expect(extended.price).toBe(165.14);
    expect(extended.change).toBeCloseTo(4.57, 8);
    expect(extended.changePercent).toBeCloseTo(2.846, 3);
    expect(getSessionMoveDisplay(afterHours)).toEqual(extended);

    for (const state of ["POSTPOST", "PREPRE", "CLOSED"] as const) {
      const quote = { ...overnight, marketState: state };
      expect(getRegularSessionDisplay(quote)!.price).toBe(160.57);
      expect(getRegularSessionDisplay(quote)!.changePercent).toBeCloseTo(-4.1945, 3);
      expect(getExtendedSessionDisplay(quote)).toMatchObject({ session: "POST", price: 164.35 });
      expect(getExtendedSessionDisplay(quote)!.change).toBeCloseTo(3.78, 8);
      // Outside an open extended session a board colors by the regular session.
      expect(getSessionMoveDisplay(quote)!.price).toBe(160.57);
    }
    // Nothing traded after the close: no extended line once the session is over.
    expect(getExtendedSessionDisplay({ ...overnight, price: 160.57 })).toBeNull();
  });

  test("a close from another session, or none, leaves the live quote as the headline", () => {
    const olderClose = { ...overnight, regularCloseSessionDate: "2026-10-07" };
    expect(getRegularSessionDisplay(olderClose)).toEqual({ price: 164.35, change: -3.25, changePercent: -1.939 });
    expect(getExtendedSessionDisplay(olderClose)).toBeNull();

    // A non-US close carries no regular close.
    const closed: Quote = { symbol: "7203.T", currency: "JPY", price: 2800, change: 12, changePercent: 0.43,
      previousClose: 2788, marketState: "CLOSED", listingExchangeName: "JPX", lastUpdated: Date.parse("2026-10-08T06:30:00Z") };
    expect(getRegularSessionDisplay(closed)).toEqual({ price: 2800, change: 12, changePercent: 0.43 });
    expect(getExtendedSessionDisplay(closed)).toBeNull();
  });

  test("after hours without a reported close takes it from the after-hours move", () => {
    // A primary quote that stops at the regular close and reports the after-hours print beside it.
    const derived = { ...afterHours, regularClose: undefined, regularCloseSessionDate: undefined,
      price: 218.36, change: -5.31, changePercent: -2.374, previousClose: 223.67,
      postMarketPrice: 218.47, postMarketChange: 0.11, postMarketChangePercent: 0.0504 };
    expect(getRegularSessionDisplay(derived)!.price).toBeCloseTo(218.36, 8);
    expect(getRegularSessionDisplay(derived)!.change).toBeCloseTo(-5.31, 8);
    expect(getExtendedSessionDisplay(derived)!.change).toBeCloseTo(0.11, 8);

    // Without either, the headline stays the live quote and the after-hours line shows what the source sent.
    const bare = { ...derived, price: 218.47, change: -5.2, changePercent: -2.325, postMarketChange: undefined, postMarketChangePercent: undefined };
    expect(getRegularSessionDisplay(bare)).toEqual({ price: 218.47, change: -5.2, changePercent: -2.325 });
    expect(getExtendedSessionDisplay(bare)).toEqual({ session: "POST", price: 218.47, change: undefined, changePercent: undefined });
  });

  test("in the pre-market the headline and the pre-market line share the previous close", () => {
    const pre: Quote = { symbol: "SPCX", currency: "USD", price: 162, change: 1.43, changePercent: 0.8906,
      previousClose: 160.57, changeSessionDate: "2026-10-09", marketState: "PRE",
      preMarketPrice: 162, preMarketChange: 1.43, preMarketChangePercent: 0.8906,
      listingExchangeName: "NASDAQ", lastUpdated: Date.parse("2026-10-09T11:00:00Z") };
    expect(getRegularSessionDisplay(pre)).toEqual({ price: 162, change: 1.43, changePercent: 0.8906 });
    expect(getExtendedSessionDisplay(pre)).toEqual({ session: "PRE", price: 162, change: 1.43, changePercent: 0.8906 });
    // Before the first pre-market trade there is no pre-market move to color a board by.
    const noTrade = { ...pre, preMarketPrice: undefined, preMarketChange: undefined, preMarketChangePercent: undefined };
    expect(getExtendedSessionDisplay(noTrade)).toBeNull();
    expect(getSessionMoveDisplay(noTrade)).toEqual({ price: 162, change: 1.43, changePercent: 0.8906 });
  });
});
