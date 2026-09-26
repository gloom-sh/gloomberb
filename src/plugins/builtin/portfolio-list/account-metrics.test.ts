import { describe, expect, test } from "bun:test";
import { useRegularMarketSession } from "../../../test-support/market-session";
import type { Quote, TickerFinancials } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import type { BrokerAccount } from "../../../types/trading";
import { convertCurrency } from "../../../utils/format";
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

  test("a reported previous close sets the day percentage, even when the snapshot NAV is later", () => {
    const now = Date.now();
    // The day figure and the NAV were taken minutes apart, so NAV minus P&L is not the prior close.
    const account: BrokerAccount = {
      accountId: "U1",
      name: "Test",
      netLiquidation: 1_010_000,
      dailyPnl: 2_000,
      previousNetLiquidation: 1_000_000,
      updatedAt: now,
      dailyPnlAsOf: now - 10 * 60_000,
    };
    const metrics = resolvePortfolioAccountMetrics(createTotals({ pricedLots: [] }), account);
    expect(metrics.dailyPnl).toBe(2_000);
    expect(metrics.dailyPnlPct).toBeCloseTo(0.2, 10);
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
  // Broker values include a small residual the rows do not carry.
  const snapshot = (overrides: Partial<BrokerAccount> = {}): BrokerAccount => ({
    accountId: "U1", name: "U1", currency: "USD", updatedAt: Date.now() - 60_000,
    grossPositionValue: 2_510, netLiquidation: 5_000, dailyPnl: 30, unrealizedPnl: 300, totalCashValue: 2_490,
    ...overrides,
  });
  const tickers = [position("AAPL", 10, 90, 100), position("MSFT", 5, 260, 300)];
  const totalsFor = (financials: Array<[string, TickerFinancials]>) => calculatePortfolioSummaryTotals(
    tickers, new Map(financials), "USD", new Map([["USD", 1]]), true, "ibkr:U1",
  );

  test("a snapshot from the position import moves by each quote against its broker mark", () => {
    const account = snapshot();
    // AAPL is 10 above the broker mark; MSFT has no current quote.
    const totals = totalsFor([["AAPL", quote("AAPL", 110, 12)]]);
    expect(totals.livePriced).toBe(false);
    expect(resolvePortfolioMarketValue(totals, account, undefined, "marks")).toBe(2_510 + 100);
    expect(resolvePortfolioNetLiquidation(totals, account, undefined, "marks")).toBe(5_000 + 100);
    const metrics = resolvePortfolioAccountMetrics(totals, account, undefined, "marks");
    expect(metrics.dailyPnl).toBe(30 + 100);
    expect(metrics.dailyPnlPct).toBeCloseTo(130 / 4_970 * 100);
    expect(metrics.unrealizedPnl).toBe(300 + 100);

    // A quote from a previous session does not price a lot.
    const stale = totalsFor([
      ["AAPL", quote("AAPL", 110, 12, { lastUpdated: Date.now() - 3 * 86_400_000 })],
      ["MSFT", quote("MSFT", 310, 4, { dataSource: "delayed" })],
    ]);
    expect(stale.livePriced).toBe(false);
    expect(resolvePortfolioMarketValue(stale, account, undefined, "marks")).toBe(2_510 + 50);
  });

  test("a snapshot loaded after the import moves only from the quotes first seen with it", () => {
    // Reloaded at 110: the broker figures already hold the move from the
    // import marks, so adding it again would count it twice.
    const reloaded = snapshot({ grossPositionValue: 2_610, netLiquidation: 5_100, dailyPnl: 130 });
    const atLoad = totalsFor([["AAPL", quote("AAPL", 110, 12)]]);
    expect(resolvePortfolioNetLiquidation(atLoad, reloaded, undefined, "loaded")).toBe(5_100);
    expect(resolvePortfolioMarketValue(atLoad, reloaded)).toBe(2_610);

    const later = totalsFor([["AAPL", quote("AAPL", 112, 14)], ["MSFT", quote("MSFT", 310, 14, { dataSource: "delayed" })]]);
    expect(resolvePortfolioNetLiquidation(later, reloaded)).toBe(5_100 + 20);
    expect(resolvePortfolioAccountMetrics(later, reloaded).dailyPnl).toBe(130 + 20);
    // A lot first quoted after the load starts from that quote.
    const latest = totalsFor([["AAPL", quote("AAPL", 112, 14)], ["MSFT", quote("MSFT", 320, 24, { dataSource: "delayed" })]]);
    expect(resolvePortfolioMarketValue(latest, reloaded)).toBe(2_610 + 20 + 50);

    // The next reload is a new snapshot with its own starting point.
    expect(resolvePortfolioNetLiquidation(latest, snapshot({ netLiquidation: 5_170 }))).toBe(5_170);
  });

  test("an FX move alone does not move a loaded snapshot twice", () => {
    // A USD account shown in EUR: converting the snapshot at the current rate
    // already moves every holding with FX.
    const account = snapshot({ grossPositionValue: 1_000, netLiquidation: 1_000, dailyPnl: 0 });
    const onlyAapl = [position("AAPL", 10, 90, 100)];
    const inEur = (eurPerUsd: number) => {
      const rates = new Map([["USD", 1], ["EUR", 1 / eurPerUsd]]);
      return {
        totals: calculatePortfolioSummaryTotals(onlyAapl, new Map([["AAPL", quote("AAPL", 100, 0, { dataSource: "delayed" })]]),
          "EUR", rates, true, "ibkr:U1"),
        convert: (value: number) => convertCurrency(value, "USD", "EUR", rates),
      };
    };
    const atLoad = inEur(0.9);
    expect(resolvePortfolioNetLiquidation(atLoad.totals, account, atLoad.convert, "loaded")).toBeCloseTo(900);
    const later = inEur(0.95);
    expect(resolvePortfolioNetLiquidation(later.totals, account, later.convert, "loaded")).toBeCloseTo(950);
    expect(resolvePortfolioMarketValue(later.totals, account, later.convert, "loaded")).toBeCloseTo(950);
    expect(resolvePortfolioAccountMetrics(later.totals, account, later.convert, "loaded").dailyPnl).toBeCloseTo(0);
  });

  test("keeps the broker's day P&L and its basis when every position turns live", () => {
    const account = snapshot();
    const totals = totalsFor([["AAPL", quote("AAPL", 110, 12)], ["MSFT", quote("MSFT", 290, -4)]]);
    expect(totals.livePriced).toBe(true);
    expect(resolvePortfolioMarketValue(totals, account, undefined, "marks")).toBe(1_100 + 1_450);
    expect(resolvePortfolioNetLiquidation(totals, account, undefined, "marks")).toBe(5_000 + 100 - 50);
    const metrics = resolvePortfolioAccountMetrics(totals, account, undefined, "marks");
    expect(metrics.dailyPnl).toBe(30 + 100 - 50);
    expect(metrics.dailyPnlPct).toBeCloseTo(80 / 4_970 * 100);
    expect(metrics.unrealizedPnl).toBe(200 + 150);

    // A day P&L from an earlier session is not today's; the quotes' is.
    const yesterday = snapshot({ updatedAt: Date.now() - 2 * 86_400_000 });
    const stale = resolvePortfolioAccountMetrics(totals, yesterday, undefined, "marks");
    expect(stale.dailyPnl).toBe(120 - 20);
    expect(stale.dailyPnlPct).toBe(totals.dailyPnlPct);
  });

  test("a short position moves the net figures against the gross value", () => {
    const quoted = calculatePortfolioSummaryTotals(
      [position("AAPL", 10, 90, 100, "short")],
      new Map([["AAPL", quote("AAPL", 110, 12, { dataSource: "delayed" })]]),
      "USD", new Map([["USD", 1]]), true, "ibkr:U1",
    );
    const shortAccount = snapshot({ grossPositionValue: 1_000, dailyPnl: -30, unrealizedPnl: -100 });
    expect(resolvePortfolioMarketValue(quoted, shortAccount, undefined, "marks")).toBe(1_100);
    expect(resolvePortfolioNetLiquidation(quoted, shortAccount, undefined, "marks")).toBe(4_900);
    expect(resolvePortfolioAccountMetrics(quoted, shortAccount, undefined, "marks").unrealizedPnl).toBe(-200);
  });
});
