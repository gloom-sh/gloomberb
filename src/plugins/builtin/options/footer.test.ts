import { describe, expect, test } from "bun:test";
import { optionContractFooterSegments, optionsCoverageSegment, resolveOptionsDelayLabel } from "./footer";

describe("options delay label", () => {
  test("prefers the chain delay and falls back to the cloud default", () => {
    expect(resolveOptionsDelayLabel({
      underlyingSymbol: "AAPL",
      expirationDates: [],
      calls: [],
      puts: [],
      delayMinutes: 20,
    })).toBe("20m");
    // A live chain reports 0, and a cached chain may omit the field entirely.
    expect(resolveOptionsDelayLabel({
      underlyingSymbol: "AAPL",
      expirationDates: [],
      calls: [],
      puts: [],
      delayMinutes: 0,
    })).toBe("15m");
    expect(resolveOptionsDelayLabel(null)).toBe("15m");
  });
});

describe("selected contract status", () => {
  const reference = (bid: number, ask: number) => ({
    contractSymbol: "AAPL260619C00101000",
    expiration: 1_782_345_600,
    currency: "USD",
    bid,
    ask,
    lastPrice: 10.1,
    lastTradeDate: 1_782_000_000,
  });
  // One hour after the contract last printed.
  const NOW = 1_782_000_000_000 + 3_600_000;
  const texts = (...args: Parameters<typeof optionContractFooterSegments>) =>
    optionContractFooterSegments(...args).map((segment) => segment.parts.map((part) => part.text).join(" "));

  test("yields the spread to a visible SPRD column, but never the reason one is missing", () => {
    expect(texts(reference(10.05, 10.15), false, NOW)).toContain("spread 0.10 (1.0% of mid)");
    expect(texts(reference(10.05, 10.15), true, NOW)).not.toContain("spread 0.10 (1.0% of mid)");
    // The column renders every degenerate quote as one dash, so the status bar
    // keeps naming them whether or not it is shown.
    for (const visible of [false, true]) {
      expect(texts(reference(10.15, 10.05), visible, NOW)).toContain("crossed quote");
      expect(texts(reference(0, 10.05), visible, NOW)).toContain("one-sided quote");
      expect(texts(reference(0, 0), visible, NOW)).toContain("no bid/ask");
    }
  });

  test("identity and staleness survive either column layout", () => {
    for (const visible of [false, true]) {
      const parts = texts(reference(10.05, 10.15), visible, NOW);
      expect(parts).toContain("AAPL260619C00101000");
      expect(parts).toContain("trade 1h");
    }
    expect(optionContractFooterSegments(undefined, false, NOW)).toEqual([]);
  });
});

describe("stream coverage on a real-time account", () => {
  test("a fallback to delayed quotes is the footer's clock, never a phrase in the row", () => {
    const delayed = optionsCoverageSegment("delayed", "15m")!;
    expect(delayed).toMatchObject({ icon: "clock", title: "Delayed options quotes, real-time stream unavailable" });
    // The terminal has no tooltip: the clock and the delay, a few cells.
    expect(delayed.parts).toEqual([{ text: "◷15m", tone: "warning" }]);
    expect(optionsCoverageSegment("mixed", "15m")).toMatchObject({ icon: "clock", parts: [{ text: "◷" }] });
    expect(optionsCoverageSegment("live", "15m")).toMatchObject({ parts: [{ text: "real-time options" }] });
    expect(optionsCoverageSegment("live", "15m")?.icon).toBeUndefined();
    expect(optionsCoverageSegment("connecting", "15m")).toBeNull();
  });
});
