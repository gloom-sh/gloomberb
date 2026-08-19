import { afterEach, describe, expect, test } from "bun:test";
import { MemoryPluginPersistence } from "../../../../test-support/plugin-persistence";
import type { DataProvider, EarningsEvent } from "../../../../types/data-provider";
import {
  attachEarningsCalendarPersistence,
  buildEarningsCacheKey,
  EARNINGS_CALENDAR_CACHE_POLICY,
  loadEarningsCalendar,
  resetEarningsCalendarPersistence,
} from "./cache";

function eventFor(symbol: string): EarningsEvent {
  return {
    symbol,
    name: `${symbol} Corp`,
    earningsDate: new Date("2026-05-01T12:00:00Z"),
    epsEstimate: 1.23,
    epsActual: null,
    revenueEstimate: 1_000_000,
    revenueActual: null,
    surprise: null,
    timing: "",
  };
}

function makeProvider(getEarningsCalendar: NonNullable<DataProvider["getEarningsCalendar"]>): DataProvider {
  return {
    id: "test",
    name: "Test",
    getTickerFinancials: async () => {
      throw new Error("getTickerFinancials is unused in this test");
    },
    getQuote: async () => {
      throw new Error("getQuote is unused in this test");
    },
    getExchangeRate: async () => 1,
    search: async () => [],
    getArticleSummary: async () => null,
    getPriceHistory: async () => [],
    getEarningsCalendar,
  };
}

afterEach(() => {
  resetEarningsCalendarPersistence();
});

describe("buildEarningsCacheKey", () => {
  test("normalizes symbol order, case, and duplicates", () => {
    expect(buildEarningsCacheKey([" msft ", "AAPL", "aapl"])).toBe("AAPL,MSFT");
  });
});

describe("loadEarningsCalendar", () => {
  test("keeps separate caches for different symbol sets", async () => {
    const calls: string[][] = [];
    const provider = makeProvider(async (symbols: string[]) => {
      calls.push(symbols);
      return symbols.map(eventFor);
    });

    const aapl = await loadEarningsCalendar(provider, ["AAPL"]);
    const msft = await loadEarningsCalendar(provider, ["MSFT"]);
    const aaplAgain = await loadEarningsCalendar(provider, ["aapl"]);

    expect(aapl.events.map((event) => event.symbol)).toEqual(["AAPL"]);
    expect(msft.events.map((event) => event.symbol)).toEqual(["MSFT"]);
    expect(aaplAgain.events.map((event) => event.symbol)).toEqual(["AAPL"]);
    expect(calls).toEqual([["AAPL"], ["MSFT"]]);
  });

  test("falls back to stale persisted data when refresh fails", async () => {
    const persistence = new MemoryPluginPersistence();
    attachEarningsCalendarPersistence(persistence);
    persistence.seedResource("calendar", "AAPL", [{
      ...eventFor("AAPL"),
      earningsDate: "2026-05-01T12:00:00.000Z",
    }], {
      sourceKey: "earnings",
      schemaVersion: 2,
      stale: true,
    });

    const provider = makeProvider(async () => {
      throw new Error("offline");
    });

    const result = await loadEarningsCalendar(provider, ["AAPL"], { force: true });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.symbol).toBe("AAPL");
    expect(result.events[0]!.earningsDate).toBeInstanceOf(Date);
    // Cached events after a provider failure are stale, not a fresh load.
    expect(result.stale).toBe(true);
    expect(result.refreshError).toContain("offline");
  });
});
