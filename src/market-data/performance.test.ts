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

  test.each([
    ["1M", "2026-03-31", "2026-02-28", "2026-03-01"],
    ["3M", "2026-05-31", "2026-02-28", "2026-03-01"],
    ["6M", "2026-08-31", "2026-02-28", "2026-03-01"],
    ["1Y", "2024-02-29", "2023-02-28", "2023-03-01"],
    ["3Y", "2024-02-29", "2021-02-28", "2021-03-01"],
    ["5Y", "2024-02-29", "2019-02-28", "2019-03-01"],
  ])("%s returns retain the target month's last observation before the next month", (id, end, cutoff, later) => {
    const history = [point(cutoff!, 100), point(later!, 150), point(end!, 200)];
    expect(buildPriceReturnFields(history).find((field) => field.id === id)?.value).toBe(1);
  });

  test("a February 28 year boundary does not move forward to February 29 in a leap year", () => {
    const history = [point("2024-02-28", 100), point("2024-02-29", 150), point("2025-02-28", 200)];
    expect(computePriceReturnForHorizon(history, horizon("1Y"))).toBe(1);
  });

  test("clamped horizons preserve zero and negative arithmetic while missing baselines stay unavailable", () => {
    for (const [baseline, latest, expected] of [
      [100, 100, 0], [100, 0, -1], [100, -50, -1.5], [-100, -50, -0.5], [0, 100, null],
      [NaN, 100, null], [100, NaN, null], [Infinity, 100, null],
    ] as const) {
      expect(computePriceReturnForHorizon([point("2026-02-28", baseline), point("2026-03-31", latest)], horizon("1M")))
        .toBe(expected);
    }
    expect(computePriceReturnForHorizon([], horizon("1M"))).toBeNull();
    expect(computePriceReturnForHorizon([point("2026-03-31", 100)], horizon("1M"))).toBeNull();
  });

  test("the selected prior-session baseline and ensuing window retain OHLC integrity checks", () => {
    const priorIssue = { ...point("2026-02-25", 110), high: 105, low: 100 };
    const clean = [priorIssue, point("2026-02-27", 100), point("2026-03-31", 150)];
    const field = (history: PricePoint[]) => buildPriceReturnFields(history, [horizon("1M")])[0]!;
    expect(field(clean)).toEqual({ id: "1M", label: "1M", value: 0.5 });
    for (const date of ["2026-02-27", "2026-02-28", "2026-03-15", "2026-03-31"]) {
      const history = [...clean, { ...point(date, 110), high: 105, low: 100 }];
      const original = JSON.stringify(history);
      expect(field(history)).toEqual({ id: "1M", label: "1M", value: null, unavailableReason: "inconsistent-ohlc" });
      expect(JSON.stringify(history)).toBe(original);
    }
  });
});
