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

  test("an exact clamped cutoff wins over the prior session and excludes observations one millisecond later", () => {
    const history = [
      point("2026-02-27T15:45:12.345Z", 90), point("2026-02-28T15:45:12.345Z", 100),
      point("2026-02-28T15:45:12.346Z", 120), point("2026-03-31T15:45:12.345Z", 150),
    ];
    const original = JSON.stringify(history);
    expect(computePriceReturnForHorizon(history, horizon("1M"))).toBe(0.5);
    expect(computePriceReturnForHorizon(JSON.parse(original), horizon("1M"))).toBe(0.5);
    expect(JSON.stringify(history)).toBe(original);
  });

  test("post-cutoff history cannot supply a full month's return", () => {
    const history = [point("2026-03-02", 100), point("2026-03-31", 110)];
    expect(buildPriceReturnFields(history).find((field) => field.id === "1M")?.value).toBeNull();
  });

  test("a February 28 year boundary does not move forward to February 29 in a leap year", () => {
    const history = [point("2024-02-28", 100), point("2024-02-29", 150), point("2025-02-28", 200)];
    expect(computePriceReturnForHorizon(history, horizon("1Y"))).toBe(1);
  });

});
