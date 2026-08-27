import { describe, expect, test } from "bun:test";
import type { BrokerAccount } from "../../../types/trading";
import type { PortfolioSummaryTotals } from "./metrics";
import { resolvePortfolioAccountMetrics, resolvePortfolioMarketValue } from "./account-metrics";

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
