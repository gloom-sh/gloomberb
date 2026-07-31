import { describe, expect, test } from "bun:test";
import type { OptionContract, Quote } from "../../../types/financials";
import type { QueryEntry } from "../../../market-data/result-types";
import type { OptionTableRow } from "./types";
import {
  buildOptionQuoteKey,
  buildOptionQuoteTargets,
  overlayOptionRowQuotes,
  resolveOptionQuoteCoverage,
} from "./live-quotes";

function contract(strike: number, side: "C" | "P"): OptionContract {
  return {
    contractSymbol: `AAPL260731${side}${String(strike * 1000).padStart(8, "0")}`,
    strike,
    currency: "USD",
    lastPrice: 1,
    change: 0,
    percentChange: 0,
    volume: 10,
    openInterest: 20,
    bid: 0.9,
    ask: 1.1,
    impliedVolatility: 0.25,
    inTheMoney: false,
    expiration: 1_785_456_000,
    lastTradeDate: 1_785_000_000,
  };
}

function row(strike: number): OptionTableRow {
  return {
    strike,
    call: contract(strike, "C"),
    put: contract(strike, "P"),
    isPositionStrike: false,
  };
}

function readyQuote(quote: Quote): QueryEntry<Quote> {
  return {
    phase: "ready",
    data: quote,
    lastGoodData: quote,
    source: quote.providerId ?? null,
    fetchedAt: quote.lastUpdated,
    staleAt: null,
    error: null,
    attempts: [],
  };
}

describe("options live quotes", () => {
  test("subscribes every visible contract plus non-visible overscan", () => {
    const rows = Array.from({ length: 100 }, (_, index) => row(50 + index));
    const targets = buildOptionQuoteTargets(rows, {
      fallbackHeight: 14,
      selectedIndex: 50,
      visibleRange: { start: 40, end: 64 },
    });
    const visibleTargets = targets.filter((target) => target.visible === true);

    expect(targets).toHaveLength(64);
    expect(visibleTargets).toHaveLength(48);
    expect(
      targets.every(
        (target) => target.exchange === "OPTIONS" && target.surface === "options",
      ),
    ).toBe(true);
    expect(targets.filter((target) => target.selected)).toHaveLength(2);
    expect(targets.some((target) => target.symbol === rows[50]!.call!.contractSymbol)).toBe(true);
    expect(visibleTargets.some((target) => target.symbol === rows[40]!.call!.contractSymbol)).toBe(true);
    expect(visibleTargets.some((target) => target.symbol === rows[63]!.put!.contractSymbol)).toBe(true);
    expect(targets.find((target) => target.symbol === rows[36]!.call!.contractSymbol)?.visible).toBe(false);
    expect(targets.some((target) => target.symbol === rows[0]!.call!.contractSymbol)).toBe(false);
    expect(targets.some((target) => target.symbol === rows.at(-1)!.put!.contractSymbol)).toBe(false);
  });

  test("requires fresh live stream metadata for every visible contract", () => {
    const rows = [row(100), row(105), row(110)];
    const targets = buildOptionQuoteTargets(rows, {
      fallbackHeight: 14,
      selectedIndex: 1,
      visibleRange: { start: 1, end: 2 },
    });
    const freshness = {
      chainAsOf: new Date(1_799_999_000_000).toISOString(),
      chainDataSource: "live" as const,
      now: 1_800_000_030_000,
      subscriptionStartedAt: 1_799_999_500_000,
    };
    const visibleRow = rows[1]!;
    const quote = (symbol: string): Quote => ({
      symbol,
      providerId: "gloomberb-cloud",
      price: 2.4,
      mark: 2.5,
      bid: 2.45,
      ask: 2.55,
      currency: "USD",
      change: 0,
      changePercent: 0,
      lastUpdated: 1_800_000_000_000,
      receivedAt: 1_800_000_010_000,
      dataSource: "live",
      delivery: "stream",
      stale: false,
    });
    const entries = new Map([
      [buildOptionQuoteKey(visibleRow.call!.contractSymbol), readyQuote(quote(visibleRow.call!.contractSymbol))],
      [buildOptionQuoteKey(visibleRow.put!.contractSymbol), readyQuote(quote(visibleRow.put!.contractSymbol))],
      [buildOptionQuoteKey(rows[0]!.call!.contractSymbol), readyQuote(quote(rows[0]!.call!.contractSymbol))],
    ]);

    expect(resolveOptionQuoteCoverage(targets, entries, freshness)).toEqual({
      fallbackCount: 0,
      liveCount: 2,
      status: "live",
      totalCount: 2,
    });

    entries.delete(buildOptionQuoteKey(visibleRow.put!.contractSymbol));
    expect(resolveOptionQuoteCoverage(targets, entries, freshness)).toMatchObject({
      liveCount: 1,
      status: "mixed",
      totalCount: 2,
    });

    entries.clear();
    entries.set(
      buildOptionQuoteKey(rows[0]!.call!.contractSymbol),
      readyQuote(quote(rows[0]!.call!.contractSymbol)),
    );
    expect(resolveOptionQuoteCoverage(targets, entries, {
      ...freshness,
      now: freshness.subscriptionStartedAt + 1_000,
    })).toMatchObject({ liveCount: 0, status: "connecting", totalCount: 2 });
  });

  test("overlays streamed quote fields while preserving chain-only Greeks and open interest", () => {
    const original = row(100);
    const symbol = original.call!.contractSymbol;
    const quote: Quote = {
      symbol,
      providerId: "gloomberb-cloud",
      price: 2.4,
      mark: 2.5,
      bid: 2.45,
      ask: 2.55,
      currency: "USD",
      change: 0,
      changePercent: 0,
      lastUpdated: 1_800_000_000_000,
      receivedAt: 1_800_000_010_000,
      dataSource: "live",
      delivery: "stream",
    };
    const entries = new Map([[buildOptionQuoteKey(symbol), readyQuote(quote)]]);
    const freshness = {
      chainAsOf: new Date(1_799_999_000_000).toISOString(),
      chainDataSource: "live" as const,
      now: 1_800_000_030_000,
      subscriptionStartedAt: 1_799_999_500_000,
    };

    const overlaid = overlayOptionRowQuotes([original], entries, freshness)[0]!.call!;

    expect(overlaid).toMatchObject({
      lastPrice: 2.5,
      bid: 2.45,
      ask: 2.55,
      lastUpdated: 1_800_000_000_000,
      impliedVolatility: 0.25,
      openInterest: 20,
    });
  });

  test("rejects quotes from before this subscription without comparing contracts to a global chain timestamp", () => {
    const original = row(100);
    const symbol = original.call!.contractSymbol;
    const quote: Quote = {
      symbol,
      providerId: "gloomberb-cloud",
      price: 9,
      mark: 9,
      bid: 8.9,
      ask: 9.1,
      currency: "USD",
      change: 0,
      changePercent: 0,
      lastUpdated: 1_800_000_000_000,
      receivedAt: 1_800_000_010_000,
      dataSource: "live",
      delivery: "stream",
      stale: false,
    };
    const entries = new Map([[buildOptionQuoteKey(symbol), readyQuote(quote)]]);

    const beforeSubscription = {
      chainAsOf: new Date(1_799_999_000_000).toISOString(),
      now: 1_800_000_030_000,
      subscriptionStartedAt: 1_800_000_020_000,
    };
    expect(overlayOptionRowQuotes([original], entries, beforeSubscription)[0]!.call!.lastPrice).toBe(1);
    const targets = buildOptionQuoteTargets([original], {
      fallbackHeight: 14,
      selectedIndex: 0,
      visibleRange: { start: 0, end: 1 },
    });
    expect(resolveOptionQuoteCoverage(targets, entries, beforeSubscription).status).not.toBe("live");

    const heterogeneousChainSnapshot = {
      chainAsOf: new Date(1_800_000_005_000).toISOString(),
      chainDataSource: "live" as const,
      now: 1_800_000_030_000,
      subscriptionStartedAt: 1_800_000_000_000,
    };
    expect(overlayOptionRowQuotes([original], entries, heterogeneousChainSnapshot)[0]!.call!.lastPrice).toBe(9);
    expect(resolveOptionQuoteCoverage(targets, entries, heterogeneousChainSnapshot)).toMatchObject({
      liveCount: 1,
      status: "mixed",
    });

    const newerContract = row(100);
    newerContract.call = {
      ...newerContract.call!,
      lastUpdated: 1_800_000_005_000,
    };
    expect(
      overlayOptionRowQuotes([newerContract], entries, heterogeneousChainSnapshot)[0]!.call!.lastPrice,
    ).toBe(1);
  });

  test("accepts a freshly delivered delayed quote older than the delayed chain fetch", () => {
    const original = row(100);
    const symbol = original.call!.contractSymbol;
    const quote: Quote = {
      symbol,
      providerId: "gloomberb-cloud",
      price: 2.2,
      mark: 2.25,
      bid: 2.2,
      ask: 2.3,
      currency: "USD",
      change: 0,
      changePercent: 0,
      lastUpdated: 1_800_000_000_000,
      receivedAt: 1_800_000_910_000,
      dataSource: "delayed",
      delivery: "poll",
      stale: false,
    };
    const entries = new Map([[buildOptionQuoteKey(symbol), readyQuote(quote)]]);
    const freshness = {
      chainAsOf: new Date(1_800_000_900_000).toISOString(),
      chainDataSource: "delayed" as const,
      now: 1_800_000_930_000,
      subscriptionStartedAt: 1_800_000_905_000,
    };

    expect(overlayOptionRowQuotes([original], entries, freshness)[0]!.call!.lastPrice).toBe(2.25);
    const targets = buildOptionQuoteTargets([original], {
      fallbackHeight: 14,
      selectedIndex: 0,
      visibleRange: { start: 0, end: 1 },
    });
    expect(resolveOptionQuoteCoverage(targets, entries, freshness).status).toBe("delayed");
  });

  test("overlays a valid polled quote without reporting a live stream", () => {
    const original = row(100);
    const symbol = original.call!.contractSymbol;
    const quote: Quote = {
      symbol,
      providerId: "gloomberb-cloud",
      price: 2.4,
      mark: 2.5,
      bid: 2.45,
      ask: 2.55,
      currency: "USD",
      change: 0,
      changePercent: 0,
      lastUpdated: 1_800_000_000_000,
      receivedAt: 1_800_000_010_000,
      dataSource: "live",
      delivery: "poll",
      stale: false,
    };
    const entries = new Map([[buildOptionQuoteKey(symbol), readyQuote(quote)]]);
    const freshness = {
      chainAsOf: new Date(1_799_999_000_000).toISOString(),
      chainDataSource: "live" as const,
      now: 1_800_000_030_000,
      subscriptionStartedAt: 1_799_999_500_000,
    };

    expect(overlayOptionRowQuotes([original], entries, freshness)[0]!.call!.lastPrice).toBe(2.5);
    const targets = buildOptionQuoteTargets([original], {
      fallbackHeight: 14,
      selectedIndex: 0,
      visibleRange: { start: 0, end: 1 },
    });
    expect(resolveOptionQuoteCoverage(targets, entries, freshness).status).toBe("delayed");
  });

  test("rejects a freshly received quote marked stale by the server", () => {
    const original = row(100);
    const symbol = original.call!.contractSymbol;
    const quote: Quote = {
      symbol,
      providerId: "gloomberb-cloud",
      price: 9,
      mark: 9,
      bid: 8.9,
      ask: 9.1,
      currency: "USD",
      change: 0,
      changePercent: 0,
      lastUpdated: 1_800_000_900_000,
      receivedAt: 1_800_000_910_000,
      dataSource: "live",
      delivery: "poll",
      stale: true,
    };
    const entries = new Map([[buildOptionQuoteKey(symbol), readyQuote(quote)]]);
    const freshness = {
      chainAsOf: new Date(1_800_000_800_000).toISOString(),
      chainDataSource: "live" as const,
      now: 1_800_000_930_000,
      subscriptionStartedAt: 1_800_000_905_000,
    };

    expect(overlayOptionRowQuotes([original], entries, freshness)[0]!.call!.lastPrice).toBe(1);
    const targets = buildOptionQuoteTargets([original], {
      fallbackHeight: 14,
      selectedIndex: 0,
      visibleRange: { start: 0, end: 1 },
    });
    expect(resolveOptionQuoteCoverage(targets, entries, freshness).status).toBe("delayed");
  });
});
