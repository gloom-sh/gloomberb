import { describe, expect, test } from "bun:test";
import { useRegularMarketSession } from "../../../test-support/market-session";
import type { Quote, TickerFinancials } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import type { BrokerAccount } from "../../../types/trading";
import { calculatePortfolioSummaryTotals, type PortfolioSummaryTotals } from "./metrics";
import { resolvePortfolioAccountMetrics, resolvePortfolioMarketValue, resolvePortfolioNetLiquidation } from "./account-metrics";

useRegularMarketSession();

function createTotals(overrides: Partial<PortfolioSummaryTotals> = {}): PortfolioSummaryTotals {
  return {
    totalMktValue: 10_000,
    dailyPnl: 50,
    dailyPnlPct: 0.5,
    totalCostBasis: 8_000,
    hasPositions: true,
    unrealizedPnl: 2_000,
    unrealizedPnlPct: 25,
    avgWatchlistChange: 0,
    watchlistCount: 0,
    ...overrides,
  };
}

describe("resolvePortfolioAccountMetrics", () => {
  test("a zero daily-P&L denominator is unavailable rather than a zero return", () => {
    for (const dailyPnl of [0, 100]) {
      const account: BrokerAccount = { accountId: "test", name: "Test", dailyPnl, netLiquidation: dailyPnl };
      const metrics = resolvePortfolioAccountMetrics(createTotals(), account);
      expect(metrics.dailyPnl).toBe(dailyPnl);
      expect(metrics.dailyPnlPct).toBeNaN();
      expect(resolvePortfolioAccountMetrics(createTotals(), { ...account, netLiquidation: dailyPnl + 1000 }).dailyPnlPct).toBe(dailyPnl / 10);
    }
  });

  test("broker account profit cannot supply a missing or zero acquisition-cost denominator", () => {
    const account: BrokerAccount = { accountId: "test", name: "Test", unrealizedPnl: 200 };
    for (const cost of [Number.NaN, 0]) {
      const result = resolvePortfolioAccountMetrics(createTotals({ totalCostBasis: cost, unrealizedPnlPct: 0 }), account);
      expect(result.unrealizedPnl).toBe(200);
      expect(result.unrealizedPnlPct).toBeNaN();
    }
    expect(resolvePortfolioAccountMetrics(createTotals({ totalCostBasis: 1000 }), account).unrealizedPnlPct).toBe(20);
  });

  test("prefers broker account P&L while preserving position fallback percentages", () => {
    const account: BrokerAccount = {
      accountId: "DU12345",
      name: "DU12345",
      netLiquidation: 12_500,
      dailyPnl: 250,
      unrealizedPnl: 1_600,
      realizedPnl: -40,
    };

    expect(resolvePortfolioAccountMetrics(createTotals(), account)).toEqual({
      dailyPnl: 250,
      dailyPnlPct: 250 / 12_250 * 100,
      unrealizedPnl: 1_600,
      unrealizedPnlPct: 20,
      realizedPnl: -40,
    });
  });

  test("converts broker account money into the app base currency", () => {
    const account: BrokerAccount = {
      accountId: "DU12345",
      name: "DU12345",
      currency: "EUR",
      netLiquidation: 10_000,
      grossPositionValue: 8_000,
      dailyPnl: 100,
      unrealizedPnl: 400,
      realizedPnl: -50,
    };
    const toUsd = (value: number) => value * 1.1;

    const metrics = resolvePortfolioAccountMetrics(createTotals(), account, toUsd);
    expect(metrics.dailyPnl).toBeCloseTo(110);
    expect(metrics.dailyPnlPct).toBeCloseTo(110 / 10_890 * 100);
    expect(metrics.unrealizedPnl).toBeCloseTo(440);
    expect(metrics.unrealizedPnlPct).toBeCloseTo(5.5);
    expect(metrics.realizedPnl).toBeCloseTo(-55);
    expect(resolvePortfolioMarketValue(createTotals(), account, toUsd)).toBeCloseTo(8_800);
  });

  test("falls back to reconstructed portfolio totals when broker P&L is missing", () => {
    expect(resolvePortfolioAccountMetrics(createTotals(), null)).toEqual({
      dailyPnl: 50,
      dailyPnlPct: 0.5,
      unrealizedPnl: 2_000,
      unrealizedPnlPct: 25,
      realizedPnl: undefined,
    });
  });
});

describe("resolvePortfolioMarketValue", () => {
  test("uses explicit broker gross position value when available", () => {
    const account: BrokerAccount = {
      accountId: "DU12345",
      name: "DU12345",
      grossPositionValue: 12_345,
      netLiquidation: 20_000,
      totalCashValue: 7_000,
    };

    expect(resolvePortfolioMarketValue(createTotals({ totalMktValue: 10_000 }), account)).toBe(12_345);
  });

  test("does not derive market value from account cash and net liquidation", () => {
    const account: BrokerAccount = {
      accountId: "DU12345",
      name: "DU12345",
      netLiquidation: 20_000,
      totalCashValue: 7_000,
    };

    expect(resolvePortfolioMarketValue(createTotals({ totalMktValue: 10_000 }), account)).toBe(10_000);
  });
});

describe("broker-linked header totals", () => {
  const position = (ticker: string, shares: number, avgCost: number, markPrice: number, side: "long" | "short" = "long"): TickerRecord => ({
    metadata: {
      ticker, exchange: "NASDAQ", currency: "USD", name: ticker, portfolios: ["ibkr:U1"], watchlists: [], custom: {}, tags: [],
      positions: [{
        portfolio: "ibkr:U1", shares, avgCost, currency: "USD", broker: "ibkr", brokerInstanceId: "ibkr-work", side,
        markPrice, marketValue: shares * markPrice, unrealizedPnl: (side === "short" ? -1 : 1) * shares * (markPrice - avgCost),
      }],
    },
  });
  const quote = (symbol: string, price: number, change: number, overrides: Partial<Quote> = {}): TickerFinancials => ({
    annualStatements: [], quarterlyStatements: [], priceHistory: [],
    quote: {
      symbol, price, change, changePercent: change / (price - change) * 100, currency: "USD", previousClose: price - change,
      lastUpdated: Date.now() - 1_000, listingExchangeName: "NASDAQ", marketState: "REGULAR", dataSource: "live", ...overrides,
    },
  });
  const account: BrokerAccount = {
    accountId: "U1", name: "U1", currency: "USD",
    // Broker values include a small residual the rows do not carry.
    grossPositionValue: 2_510, netLiquidation: 5_000, dailyPnl: 30, unrealizedPnl: 300, totalCashValue: 2_490,
  };
  const tickers = [position("AAPL", 10, 90, 100), position("MSFT", 5, 260, 300)];
  const totalsFor = (financials: Array<[string, TickerFinancials]>) => calculatePortfolioSummaryTotals(
    tickers, new Map(financials), "USD", new Map([["USD", 1]]), true, "ibkr:U1",
  );

  test("anchors on the broker snapshot and adds the move of quoted positions", () => {
    // AAPL is 10 above the broker mark; MSFT has no current quote.
    const totals = totalsFor([["AAPL", quote("AAPL", 110, 12)]]);
    expect(totals.livePriced).toBe(false);
    expect(resolvePortfolioMarketValue(totals, account)).toBe(2_510 + 100);
    expect(resolvePortfolioNetLiquidation(totals, account)).toBe(5_000 + 100);
    const metrics = resolvePortfolioAccountMetrics(totals, account);
    expect(metrics.dailyPnl).toBe(30 + 100);
    expect(metrics.dailyPnlPct).toBeCloseTo(130 / 4_970 * 100);
    expect(metrics.unrealizedPnl).toBe(300 + 100);

    // A quote from a previous session or a delayed feed does not count as live.
    const stale = totalsFor([
      ["AAPL", quote("AAPL", 110, 12, { lastUpdated: Date.now() - 3 * 86_400_000 })],
      ["MSFT", quote("MSFT", 310, 4, { dataSource: "delayed" })],
    ]);
    expect(stale.livePriced).toBe(false);
    expect(resolvePortfolioMarketValue(stale, account)).toBe(2_510 + 50);
  });

  test("uses quote totals once every position has a current real-time quote", () => {
    const totals = totalsFor([["AAPL", quote("AAPL", 110, 12)], ["MSFT", quote("MSFT", 290, -4)]]);
    expect(totals.livePriced).toBe(true);
    expect(resolvePortfolioMarketValue(totals, account)).toBe(1_100 + 1_450);
    expect(resolvePortfolioNetLiquidation(totals, account)).toBe(5_000 + 100 - 50);
    const metrics = resolvePortfolioAccountMetrics(totals, account);
    expect(metrics.dailyPnl).toBe(120 - 20);
    expect(metrics.unrealizedPnl).toBe(200 + 150);
  });

  test("a short position moves the net figures against the gross value", () => {
    const quoted = calculatePortfolioSummaryTotals(
      [position("AAPL", 10, 90, 100, "short")],
      new Map([["AAPL", quote("AAPL", 110, 12, { dataSource: "delayed" })]]),
      "USD", new Map([["USD", 1]]), true, "ibkr:U1",
    );
    expect(quoted.brokerSnapshotDelta).toEqual({ gross: 100, net: -100 });
    const shortAccount: BrokerAccount = { ...account, grossPositionValue: 1_000, dailyPnl: -30, unrealizedPnl: -100 };
    expect(resolvePortfolioMarketValue(quoted, shortAccount)).toBe(1_100);
    expect(resolvePortfolioAccountMetrics(quoted, shortAccount).unrealizedPnl).toBe(-200);
  });
});
