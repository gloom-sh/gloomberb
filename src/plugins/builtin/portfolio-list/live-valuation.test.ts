import { describe, expect, test } from "bun:test";
import type { AnalystResearchData, Fundamentals, Quote } from "../../../types/financials";
import {
  liveDividendYield,
  liveFiftyTwoWeekRange,
  liveForwardPE,
  liveMarketCapitalization,
  liveTrailingPE,
  targetReferencePrice,
} from "./live-valuation";

function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    symbol: "X", price: 110, currency: "USD", change: 10, changePercent: 10, previousClose: 100, lastUpdated: 1,
    ...overrides,
  };
}

function research(priceTarget: AnalystResearchData["priceTarget"], currency?: string): AnalystResearchData {
  return { symbol: "X", currency, priceTarget, recommendations: [], ratings: [], earningsEstimates: [], revenueEstimates: [] };
}

describe("live valuation", () => {
  test("reprices market cap only from shares on the capitalization's own listing and unit", () => {
    const fundamentals: Fundamentals = { marketCap: 1_000, marketCapCurrency: "USD", sharesOutstanding: 10 };
    expect(liveMarketCapitalization(quote(), fundamentals)).toMatchObject({ value: 1_100, currency: "USD", live: true });
    // The basis check reads the reference close, so a large move today still reprices.
    expect(liveMarketCapitalization(quote({ price: 140, change: 40 }), fundamentals)).toMatchObject({ value: 1_400, live: true });
    // Two ordinary shares per listed share (an ADR ratio) keep the stored cap.
    expect(liveMarketCapitalization(quote(), { ...fundamentals, sharesOutstanding: 20 })).toMatchObject({ value: 1_000, live: false });
    // An issuer capitalization in another currency than the listing is never scaled by its price.
    expect(liveMarketCapitalization(quote(), { ...fundamentals, marketCapCurrency: "EUR" }))
      .toMatchObject({ value: 1_000, currency: "EUR", live: false });
    // A capitalization priced during today's session (the quote's own, or one
    // the server repriced) proves its count against the session range.
    expect(liveMarketCapitalization(quote({ marketCap: 1_050, low: 98, high: 112 }), fundamentals))
      .toMatchObject({ value: 1_100, live: true });
    expect(liveMarketCapitalization(quote({ marketCap: 1_050 }), fundamentals)?.live).toBe(false);
    expect(liveMarketCapitalization(quote({ priceBasis: "percent-of-par" }), fundamentals)?.live).toBe(false);
  });

  test("keeps the stored cap when the share count is on another class", () => {
    // META: the class A count implies 851 against a 747 close.
    const meta = quote({ price: 750, change: 3, previousClose: 747, low: 741, high: 756 });
    const classA: Fundamentals = { marketCap: 1.88e12, marketCapCurrency: "USD", sharesOutstanding: 1.88e12 / 851 };
    expect(liveMarketCapitalization(meta, classA)).toMatchObject({ value: 1.88e12, live: false });
    // A count about 1% off the close is not the close either.
    const drifted: Fundamentals = { ...classA, sharesOutstanding: 1.88e12 / 755 };
    expect(liveMarketCapitalization({ ...meta, low: 745, high: 749 }, drifted)?.live).toBe(false);
    // The full count at the close reprices.
    const full: Fundamentals = { ...classA, sharesOutstanding: 1.88e12 / 747 };
    expect(liveMarketCapitalization(meta, full)?.value).toBeCloseTo(1.88e12 / 747 * 750, -3);
  });

  test("reprices trailing P/E with the served rules", () => {
    const fundamentals: Fundamentals = { trailingPE: 20, eps: 5, marketCapCurrency: "USD" };
    expect(liveTrailingPE(quote(), fundamentals)).toBeCloseTo(22);
    // The quote's own price, as served, not a separate post-market print.
    expect(liveTrailingPE(quote({ marketState: "POST", postMarketPrice: 120 }), fundamentals)).toBeCloseTo(22);
    // Losses and zero earnings keep the stored multiple and its N/M display.
    expect(liveTrailingPE(quote(), { ...fundamentals, trailingPE: -12, eps: -9 })).toBe(-12);
    expect(liveTrailingPE(quote(), { ...fundamentals, eps: 0 })).toBe(20);
    // EPS on another basis than the multiple (11x drift) and a minor-unit block stay stored.
    expect(liveTrailingPE(quote(), { ...fundamentals, eps: 0.5 })).toBe(20);
    expect(liveTrailingPE(quote({ currency: "GBP" }), { ...fundamentals, marketCapCurrency: "GBp" })).toBe(20);
  });

  test("reprices forward P/E and yield only when the forward per-share figure is served", () => {
    const fundamentals = { forwardPE: 18, dividendYield: 0.02, marketCapCurrency: "USD" } as Fundamentals;
    expect(liveForwardPE(quote(), fundamentals)).toBe(18);
    expect(liveDividendYield(quote(), fundamentals)).toBe(0.02);
    const served = { ...fundamentals, forwardEps: 5.5, dividendRate: 2 } as Fundamentals;
    expect(liveForwardPE(quote(), served)).toBeCloseTo(20);
    expect(liveDividendYield(quote(), served)).toBeCloseTo(2 / 110);
  });

  test("folds today's session into the 52-week range", () => {
    expect(liveFiftyTwoWeekRange(quote({ high52w: 105, low52w: 80, high: 112, low: 101 }))).toEqual({ low: 80, high: 112 });
    expect(liveFiftyTwoWeekRange(quote({ high52w: 150, low52w: 80 }))).toEqual({ low: 80, high: 150 });
    // A post-market print beyond the high is the position's new extreme.
    expect(liveFiftyTwoWeekRange(quote({ high52w: 105, low52w: 80 }), 118)).toEqual({ low: 80, high: 118 });
    expect(liveFiftyTwoWeekRange(quote({ high52w: undefined, low52w: 80 }))).toBeNull();
  });

  test("compares analyst targets with the live price only on the target's currency and unit", () => {
    expect(targetReferencePrice(research({ average: 150, current: 100, currency: "USD" }), "USD", 110)).toBe(110);
    expect(targetReferencePrice(research({ average: 150 }), "USD", 110)).toBe(110);
    // A target in another listing's currency keeps the research snapshot's own price.
    expect(targetReferencePrice(research({ average: 40, current: 35 }, "EUR"), "USD", 110)).toBe(35);
    expect(targetReferencePrice(research({ average: 40 }, "EUR"), "USD", 110)).toBeNull();
    // A snapshot in pence beside a pound price is on another unit.
    expect(targetReferencePrice(research({ average: 2_400, current: 2_150 }, "GBP"), "GBP", 21.6)).toBe(2_150);
  });
});
