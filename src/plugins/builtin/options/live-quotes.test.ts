import { describe, expect, test } from "bun:test";
import type { OptionContract, OptionsChain, Quote } from "../../../types/financials";
import type { QueryEntry } from "../../../market-data/result-types";
import { DEFAULT_OPTION_CALC_DRAFT, daysToExpiryFrom, solveImpliedVolatility, valueOption } from "../options-calculator/model";
import { calculateOptionGreeks, solveChainVolatilities } from "./analytics";
import type { OptionTableRow } from "./types";
import {
  buildOptionQuoteKey,
  buildOptionQuoteTargets,
  overlayOptionChainQuotes,
  overlayOptionContractQuote,
  resolveOptionQuoteCoverage,
  type OptionsQuoteFreshness,
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

/** The row's contracts after the chain overlay, as OMON renders them. */
function overlayOptionRowQuotes(rows: OptionTableRow[], entries: ReadonlyMap<string, QueryEntry<Quote>>, freshness: OptionsQuoteFreshness) {
  const chain: OptionsChain = { underlyingSymbol: "AAPL", expirationDates: [1_785_456_000],
    calls: rows.flatMap((entry) => entry.call ? [entry.call] : []), puts: rows.flatMap((entry) => entry.put ? [entry.put] : []) };
  const live = overlayOptionChainQuotes(chain, entries, freshness).chain;
  return rows.map((entry) => ({ ...entry, call: live.calls.find((item) => item.strike === entry.strike),
    put: live.puts.find((item) => item.strike === entry.strike) }));
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
      lastPrice: 1,
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
    expect(overlayOptionRowQuotes([original], entries, heterogeneousChainSnapshot)[0]!.call!.bid).toBe(8.9);
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

    expect(overlayOptionRowQuotes([original], entries, freshness)[0]!.call!.bid).toBe(2.2);
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

    expect(overlayOptionRowQuotes([original], entries, freshness)[0]!.call!.bid).toBe(2.45);
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

test("LAST only advances for a dated executed trade, never a mark or older trade", () => {
  const original = contract(100, "C");
  const quote: Quote = { symbol: original.contractSymbol, price: 8, mark: 9,
    currency: "USD", change: 0, changePercent: 0, lastUpdated: 1_800_000_000_000,
    lastTradePrice: 7, lastTradeTime: 1_790_000_000_000 };
  const updated = overlayOptionContractQuote(original, quote)!;
  expect(updated.lastPrice).toBe(7);
  expect(updated.lastTradeDate).toBe(1_790_000_000);
  expect(overlayOptionContractQuote(updated, { ...quote, lastTradePrice: 5,
    lastTradeTime: 1_789_000_000_000 })!.lastPrice).toBe(7);
  expect(overlayOptionContractQuote(original, { ...quote, lastTradeTime: undefined })!.lastPrice).toBe(original.lastPrice);
});

test("streamed session volume grows the contract's volume and never shrinks it", () => {
  const original = contract(100, "C");
  const quote: Quote = { symbol: original.contractSymbol, price: 1, currency: "USD", change: 0, changePercent: 0,
    lastUpdated: 1_800_000_000_000, volume: 25 };
  expect(overlayOptionContractQuote(original, quote)!.volume).toBe(25);
  // An older anchor below the snapshot's count is not a correction.
  expect(overlayOptionContractQuote(original, { ...quote, volume: 4 })!.volume).toBe(10);
  expect(overlayOptionContractQuote({ ...original, volume: undefined }, { ...quote, volume: 0 })!.volume).toBe(0);
  expect(overlayOptionContractQuote(original, { ...quote, volume: undefined })!.volume).toBe(10);
});

test("a streamed midpoint re-solves its strike's IV and Greeks at the live spot; the rest keep the snapshot", () => {
  const now = Date.parse("2026-09-23T15:00:00Z");
  const expiration = Date.UTC(2026, 9, 16) / 1000;
  const days = daysToExpiryFrom(expiration, now);
  const priced = (strike: number, side: "call" | "put", volatility: number): OptionContract => {
    const price = valueOption({ ...DEFAULT_OPTION_CALC_DRAFT, side, spot: 100, strike, daysToExpiry: days,
      volatility, rate: DEFAULT_OPTION_CALC_DRAFT.rate, dividendYield: 0 }).price;
    return { ...contract(strike, side === "call" ? "C" : "P"), expiration, bid: price - 0.01, ask: price + 0.01, lastPrice: price };
  };
  const strikes = [90, 95, 100, 105, 110];
  const chain: OptionsChain = { underlyingSymbol: "AAPL", expirationDates: [expiration], asOf: new Date(now - 5_000).toISOString(),
    calls: strikes.map((strike) => priced(strike, "call", 0.25)), puts: strikes.map((strike) => priced(strike, "put", 0.25)) };
  const freshness = { now, subscriptionStartedAt: now - 60_000 };
  const snapshot = solveChainVolatilities(chain, 100, 0, now);
  expect(overlayOptionChainQuotes(chain, new Map(), freshness).chain).toBe(chain);

  // The 105 call reprices to a 30% volatility while every other quote stands still.
  const call105 = chain.calls[3]!;
  const liveMid = valueOption({ ...DEFAULT_OPTION_CALC_DRAFT, side: "call", spot: 100, strike: 105, daysToExpiry: days,
    volatility: 0.3, rate: DEFAULT_OPTION_CALC_DRAFT.rate, dividendYield: 0 }).price;
  const streamed: Quote = { symbol: call105.contractSymbol, price: liveMid, bid: liveMid - 0.01, ask: liveMid + 0.01,
    currency: "USD", change: 0, changePercent: 0, lastUpdated: now - 1_000, receivedAt: now - 500,
    dataSource: "live", delivery: "stream", stale: false };
  const live = overlayOptionChainQuotes(chain, new Map([[buildOptionQuoteKey(call105.contractSymbol), readyQuote(streamed)]]), freshness);
  expect([...live.streamedStrikes]).toEqual([105]);
  expect(live.chain.calls[3]!.bid).toBeCloseTo(liveMid - 0.01, 10);
  expect(live.chain.asOf).toBe(new Date(now - 1_000).toISOString());

  const volatilities = solveChainVolatilities(live.chain, 100, 0, now);
  const expected = solveImpliedVolatility({ ...DEFAULT_OPTION_CALC_DRAFT, side: "call", spot: 100, strike: 105,
    daysToExpiry: days, volatility: 0.25, dividendYield: 0 }, liveMid).volatility!;
  expect(volatilities.byStrike.get(105)!).toBeGreaterThan(snapshot.byStrike.get(105)! + 0.03);
  expect(volatilities.byStrike.get(105)!).toBeCloseTo(expected, 2);
  expect(volatilities.byStrike.get(95)!).toBeCloseTo(snapshot.byStrike.get(95)!, 6);
  // Greeks follow the re-solved volatility and the spot they are given.
  const before = calculateOptionGreeks(chain.calls[3], "call", 100, 0, snapshot)!;
  const after = calculateOptionGreeks(live.chain.calls[3], "call", 101, 0, volatilities)!;
  expect(after.delta).toBeGreaterThan(before.delta);
  expect(after.price).toBeCloseTo(valueOption({ ...DEFAULT_OPTION_CALC_DRAFT, side: "call", spot: 101, strike: 105,
    daysToExpiry: daysToExpiryFrom(expiration, volatilities.valuationTime), volatility: volatilities.byStrike.get(105)!,
    dividendYield: 0 }).price, 10);
});
