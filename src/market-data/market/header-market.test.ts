import { describe, expect, test } from "bun:test";
import { defaultHeaderBenchmark, resolveHeaderMarket, sanitizeHeaderMarketChoice } from "./header-market";

describe("header market", () => {
  test("starts on the benchmark of the machine's time zone", () => {
    const zones: Record<string, string> = {
      "Asia/Hong_Kong": "Hang Seng",
      "Asia/Singapore": "STI",
      "Asia/Shanghai": "CSI 300",
      "Asia/Tokyo": "Nikkei 225",
      "Europe/London": "FTSE 100",
      "Europe/Berlin": "DAX",
      "Europe/Paris": "DAX",
      "Europe/Madrid": "DAX",
      "America/New_York": "S&P 500",
      "America/Los_Angeles": "S&P 500",
      "Europe/Dublin": "S&P 500",
      "Australia/Sydney": "S&P 500",
      UTC: "S&P 500",
    };
    for (const [zone, name] of Object.entries(zones)) expect([zone, defaultHeaderBenchmark(zone).name]).toEqual([zone, name]);
    expect(defaultHeaderBenchmark(undefined).name).toBe("S&P 500");
  });

  test("follows the saved choice over the time zone, and reads a benchmark found by its symbol by name", () => {
    expect(resolveHeaderMarket(undefined, "Asia/Hong_Kong")).toMatchObject({ label: "Hang Seng", symbol: "^HSI", venue: "HKEX" });
    expect(resolveHeaderMarket({ benchmark: "dax" }, "Asia/Hong_Kong")).toMatchObject({ label: "DAX", venue: "XETRA" });
    expect(resolveHeaderMarket({ symbol: "^HSI", exchange: "HKSE" }, "America/New_York")).toMatchObject({ label: "Hang Seng", benchmarkId: "hang-seng" });
    expect(resolveHeaderMarket({ symbol: "AAPL", exchange: "NASDAQ" }, "Asia/Tokyo")).toMatchObject({
      label: "AAPL", symbol: "AAPL", exchange: "NASDAQ", venue: null, fallback: null,
    });
  });

  /** A config written by another build, or by hand, must never leave the header on a market it cannot resolve. */
  test("reads a saved choice it offers and drops anything else", () => {
    expect(sanitizeHeaderMarketChoice({ benchmark: "hang-seng" })).toEqual({ benchmark: "hang-seng" });
    expect(sanitizeHeaderMarketChoice({ benchmark: "ibex35" })).toBeUndefined();
    expect(sanitizeHeaderMarketChoice({ symbol: " AAPL ", exchange: " NASDAQ " })).toEqual({ symbol: "AAPL", exchange: "NASDAQ" });
    expect(sanitizeHeaderMarketChoice({ symbol: "AAPL", exchange: "" })).toEqual({ symbol: "AAPL" });
    for (const junk of [null, "sp500", { symbol: "" }, { symbol: 3 }, []]) expect(sanitizeHeaderMarketChoice(junk)).toBeUndefined();
  });
});
