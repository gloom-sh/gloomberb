import { describe, expect, test } from "bun:test";
import type { Quote } from "../../../types/financials";
import {
  formatTickerBadgeChange,
  getTickerBadgeCellWidth,
  getTickerBadgeText,
} from "./format";

const quote: Quote = {
  symbol: "NFLX",
  price: 1234.5,
  currency: "USD",
  change: 12.3,
  changePercent: 1.24,
  lastUpdated: 1,
};

describe("formatTickerBadgeChange", () => {
  test("keeps one decimal and loses a pointless minus on zero", () => {
    expect(formatTickerBadgeChange(1.24)).toBe("+1.2%");
    expect(formatTickerBadgeChange(-5)).toBe("-5%");
    expect(formatTickerBadgeChange(-0.01)).toBe("0%");
  });
});

describe("getTickerBadgeText", () => {
  test("shows the change next to the symbol once a quote is in", () => {
    expect(getTickerBadgeText({ symbol: "NFLX", status: "ready", quote })).toBe("NFLX +1.2%");
  });

  test("waits with an ellipsis while the quote is loading", () => {
    expect(getTickerBadgeText({ symbol: "NFLX", status: "loading", quote: null })).toBe("NFLX \u2026");
  });

  test("an ambiguous symbol waits for nothing", () => {
    expect(getTickerBadgeText({ symbol: "QSR", status: "ambiguous", quote: null })).toBe("QSR");
  });

  test("hovering trades the change for the price", () => {
    expect(getTickerBadgeText({ symbol: "NFLX", status: "ready", quote, hovered: true }))
      .toContain("1,234.50");
  });

  test("a narrow column drops the price rather than clipping it", () => {
    expect(getTickerBadgeText({ symbol: "NFLX", status: "ready", quote, maxTextWidth: 10 }))
      .toBe("NFLX +1.2%");
    expect(getTickerBadgeText({ symbol: "NFLX", status: "ready", quote, maxTextWidth: 9 }))
      .toBe("NFLX");
    expect(getTickerBadgeText({ symbol: "NFLX", status: "ready", quote, hovered: true, maxTextWidth: 10 }))
      .toBe("NFLX +1.2%");
  });

  test("the symbol survives a budget too small for anything", () => {
    expect(getTickerBadgeText({ symbol: "NFLX", status: "ready", quote, maxTextWidth: 1 })).toBe("NFLX");
  });

  test("a badge without live quotes stays a bare symbol", () => {
    expect(getTickerBadgeText({ symbol: "NFLX", status: "ready", quote, liveQuote: false })).toBe("NFLX");
  });
});

describe("getTickerBadgeCellWidth", () => {
  test("counts the chip padding and the gap after it", () => {
    expect(getTickerBadgeCellWidth({ symbol: "NFLX", status: "ready", quote })).toBe(13);
  });
});
