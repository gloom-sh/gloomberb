import { describe, expect, test } from "bun:test";
import type { OptionContract, Quote } from "../../../types/financials";
import type { QueryEntry } from "../../../market-data/result-types";
import type { OptionTableRow } from "./types";
import {
  buildOptionQuoteKey,
  buildOptionQuoteTargets,
  hasLiveOptionQuote,
  overlayOptionRowQuotes,
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
  test("bounds selected-expiry subscriptions around the current strike", () => {
    const rows = Array.from({ length: 100 }, (_, index) => row(50 + index));
    const targets = buildOptionQuoteTargets(rows, 50, 14);

    expect(targets).toHaveLength(16);
    expect(
      targets.every(
        (target) => target.exchange === "OPTIONS" && target.surface === "options" && target.visible === true,
      ),
    ).toBe(true);
    expect(targets.filter((target) => target.selected)).toHaveLength(2);
    expect(targets.some((target) => target.symbol === rows[50]!.call!.contractSymbol)).toBe(true);
    expect(targets.some((target) => target.symbol === rows[0]!.call!.contractSymbol)).toBe(false);
    expect(targets.some((target) => target.symbol === rows.at(-1)!.put!.contractSymbol)).toBe(false);
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
    expect(hasLiveOptionQuote(entries, freshness)).toBe(true);
  });

  test("rejects cached quotes from before this subscription or the current chain", () => {
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
    };
    const entries = new Map([[buildOptionQuoteKey(symbol), readyQuote(quote)]]);

    const beforeSubscription = {
      chainAsOf: new Date(1_799_999_000_000).toISOString(),
      now: 1_800_000_030_000,
      subscriptionStartedAt: 1_800_000_020_000,
    };
    expect(overlayOptionRowQuotes([original], entries, beforeSubscription)[0]!.call!.lastPrice).toBe(1);
    expect(hasLiveOptionQuote(entries, beforeSubscription)).toBe(false);

    const olderThanChain = {
      chainAsOf: new Date(1_800_000_005_000).toISOString(),
      chainDataSource: "live" as const,
      now: 1_800_000_030_000,
      subscriptionStartedAt: 1_800_000_000_000,
    };
    expect(overlayOptionRowQuotes([original], entries, olderThanChain)[0]!.call!.lastPrice).toBe(1);
    expect(hasLiveOptionQuote(entries, olderThanChain)).toBe(false);
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
    expect(hasLiveOptionQuote(entries, freshness)).toBe(false);
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
    expect(hasLiveOptionQuote(entries, freshness)).toBe(false);
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
    expect(hasLiveOptionQuote(entries, freshness)).toBe(false);
  });
});
