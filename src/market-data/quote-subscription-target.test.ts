import { describe, expect, test } from "bun:test";
import { mergeQuoteSubscriptionTargets } from "./quote-subscription-target";

describe("mergeQuoteSubscriptionTargets", () => {
  test("does not synthesize optional priority fields", () => {
    const merged = mergeQuoteSubscriptionTargets([
      { symbol: "AAPL", exchange: "NASDAQ" },
      { symbol: "AAPL", exchange: "NASDAQ" },
    ]);

    expect(merged).toEqual({ symbol: "AAPL", exchange: "NASDAQ" });
    expect(merged).not.toHaveProperty("visible");
    expect(merged).not.toHaveProperty("selected");
    expect(merged).not.toHaveProperty("weight");
  });

  test("combines priority fields that callers explicitly provide", () => {
    const merged = mergeQuoteSubscriptionTargets([
      { symbol: "TSLA", surface: "watchlist" as const, visible: true, selected: false, weight: 5 },
      { symbol: "TSLA", surface: "detail" as const, visible: false, selected: true, weight: 20 },
    ]);

    expect(merged).toEqual({
      symbol: "TSLA",
      surface: "detail",
      visible: true,
      selected: true,
      weight: 20,
    });
  });

  test("preserves explicit false and zero values", () => {
    expect(mergeQuoteSubscriptionTargets([
      { symbol: "MSFT", visible: false, selected: false, weight: 0 },
    ])).toEqual({ symbol: "MSFT", visible: false, selected: false, weight: 0 });
  });
});
