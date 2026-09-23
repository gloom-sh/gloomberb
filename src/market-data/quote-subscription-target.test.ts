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

  test("keeps one route per instrument whichever pane ranks highest", () => {
    const portfolioRow = (selected: boolean) => ({
      symbol: "AAPL", route: "broker" as const, surface: "portfolio" as const, visible: true, selected, weight: selected ? 100 : 80,
    });
    const detail = { symbol: "AAPL", route: "provider" as const, surface: "detail" as const, visible: true, selected: true, weight: 100 };
    const watchlist = { symbol: "AAPL", route: "auto" as const, surface: "watchlist" as const, visible: true, weight: 80 };

    for (const targets of [
      [detail, portfolioRow(false)],
      [portfolioRow(true), detail],
      [watchlist, portfolioRow(false), detail],
    ]) {
      expect(mergeQuoteSubscriptionTargets(targets)?.route).toBe("broker");
    }
    expect(mergeQuoteSubscriptionTargets([detail, portfolioRow(false)])?.surface).toBe("detail");
    expect(mergeQuoteSubscriptionTargets([watchlist, detail])?.route).toBe("provider");
    expect(mergeQuoteSubscriptionTargets([{ symbol: "AAPL" }, watchlist])?.route).toBe("auto");
  });

  test("preserves explicit false and zero values", () => {
    expect(mergeQuoteSubscriptionTargets([
      { symbol: "MSFT", visible: false, selected: false, weight: 0 },
    ])).toEqual({ symbol: "MSFT", visible: false, selected: false, weight: 0 });
  });
});
