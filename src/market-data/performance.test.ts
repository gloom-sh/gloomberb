import { describe, expect, test } from "bun:test";
import {
  appendQuoteToPriceReturnHistory,
  buildPriceReturnFields,
  computePriceReturnForHorizon,
  PRICE_RETURN_HORIZONS,
} from "./performance";
import type { PricePoint } from "../types/financials";

function point(date: string, close: number): PricePoint {
  return { date: new Date(date.length === 10 ? `${date}T00:00:00Z` : date), close };
}

const horizon = (id: string) => PRICE_RETURN_HORIZONS.find((entry) => entry.id === id)!;

describe("price performance", () => {
  test("computes horizon return from the closest prior baseline", () => {
    const history = [
      point("2025-12-31", 100),
      point("2026-01-02", 102),
      point("2026-01-31", 110),
      point("2026-02-01", 120),
    ];

    const oneMonth = PRICE_RETURN_HORIZONS.find((horizon) => horizon.id === "1M")!;

    expect(computePriceReturnForHorizon(history, oneMonth)).toBeCloseTo(20 / 100);
  });

  test("leaves fixed horizons empty when history does not reach the baseline date", () => {
    const history = [
      point("2026-01-15", 100),
      point("2026-02-01", 110),
    ];

    const fields = buildPriceReturnFields(history);

    expect(fields.find((field) => field.id === "1M")?.value).toBeNull();
    expect(fields.find((field) => field.id === "1Y")?.value).toBeNull();
  });

  test("can include a newer live quote as the latest return point", () => {
    const history = [
      point("2025-01-31", 100),
      point("2026-01-31", 120),
    ];
    const withQuote = appendQuoteToPriceReturnHistory(history, {
      price: 150,
      lastUpdated: Date.parse("2026-02-01T15:30:00Z"),
    });
    const oneYear = PRICE_RETURN_HORIZONS.find((horizon) => horizon.id === "1Y")!;

    expect(withQuote).toHaveLength(3);
    expect(computePriceReturnForHorizon(withQuote, oneYear)).toBeCloseTo(50 / 100);
  });

  test("a month ending on a closed day uses the prior session rather than the next month's price move", () => {
    const history = [point("2026-02-27", 100), point("2026-03-02", 120), point("2026-03-31", 150)];
    expect(computePriceReturnForHorizon(history, horizon("1M"))).toBe(0.5);
  });

  test("the clamped base day's last observation is the base, not the prior session's or the time of day a month back", () => {
    // A month before 31 Mar is 28 Feb: its close is the last observation that day.
    const history = [
      point("2026-02-27T15:45:12.345Z", 90), point("2026-02-28T15:45:12.345Z", 100),
      point("2026-02-28T15:45:12.346Z", 120), point("2026-03-31T15:45:12.345Z", 150),
    ];
    const original = JSON.stringify(history);
    expect(computePriceReturnForHorizon(history, horizon("1M"))).toBe(0.25);
    expect(computePriceReturnForHorizon(JSON.parse(original), horizon("1M"))).toBe(0.25);
    expect(JSON.stringify(history)).toBe(original);
  });

  test("post-cutoff history cannot supply a full month's return", () => {
    const history = [point("2026-03-02", 100), point("2026-03-31", 110)];
    expect(buildPriceReturnFields(history).find((field) => field.id === "1M")?.value).toBeNull();
  });

  test("bars and the quote are dated on the listing's clock, not by their UTC date", () => {
    // A JPX feed stamps each daily bar at 00:00 JST, 15:00 UTC the day before; the quote is Thu 22 Oct 15:00 JST.
    const jpx = [point("2026-09-20T15:00:00Z", 90), point("2026-09-21T15:00:00Z", 100), point("2026-09-22T15:00:00Z", 120), point("2026-10-20T15:00:00Z", 140)];
    const tokyo = appendQuoteToPriceReturnHistory(jpx, { price: 150, lastUpdated: Date.parse("2026-10-22T06:00:00Z") });
    // A month before 22 Oct is Tue 22 Sep: its bar, not 23 Sep's (stamped 22 Sep 15:00 UTC).
    expect(computePriceReturnForHorizon(tokyo, horizon("1M"), "JPX")).toBeCloseTo(0.5);
    // Tue 1 Dec 19:30 New York after hours is 2 Dec in UTC: a month before 1 Dec is Sun 1 Nov, so Fri 30 Oct's close.
    const us = appendQuoteToPriceReturnHistory([point("2026-10-30", 100), point("2026-11-02", 120), point("2026-12-01", 140)],
      { price: 150, lastUpdated: Date.parse("2026-12-02T00:30:00Z") });
    expect(computePriceReturnForHorizon(us, horizon("1M"), "NASDAQ")).toBeCloseTo(0.5);
  });

  test("a February 28 year boundary does not move forward to February 29 in a leap year", () => {
    const history = [point("2024-02-28", 100), point("2024-02-29", 150), point("2025-02-28", 200)];
    expect(computePriceReturnForHorizon(history, horizon("1Y"))).toBe(1);
  });

});
